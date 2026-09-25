/**
 * `imagine edit`: photo editing as a sequence of steps (remove, add, change the background, change
 * or swap a face, restyle, extend the scene), each phrased the way FLUX.2 Klein edits best. A plain
 * English request can be planned into steps by a local chat model, and a vision model can check each
 * result and ask for a retry.
 */
import { OllamaError, type ModelInfo } from './ollama.ts';
import { cleanPrompt } from './enhance.ts';

export const EDIT_OPS = ['remove', 'add', 'background', 'face', 'swap-face', 'style', 'extend', 'custom'] as const;
export type EditOpName = (typeof EDIT_OPS)[number];

export interface EditStep {
  op: EditOpName;
  /** What to remove or add, the new background, face or style, the extend ratio, or a free instruction. */
  value: string;
}

/** Flags in the order that edits compose best: content first, size last. */
export function stepsFromFlags(flags: {
  remove?: string[];
  add?: string[];
  face?: string;
  swapFace?: string;
  background?: string;
  style?: string;
  extend?: string;
}): EditStep[] {
  const steps: EditStep[] = [];
  for (const value of flags.remove ?? []) steps.push({ op: 'remove', value });
  for (const value of flags.add ?? []) steps.push({ op: 'add', value });
  if (flags.face) steps.push({ op: 'face', value: flags.face });
  if (flags.swapFace) steps.push({ op: 'swap-face', value: flags.swapFace });
  if (flags.background) steps.push({ op: 'background', value: flags.background });
  if (flags.style) steps.push({ op: 'style', value: flags.style });
  if (flags.extend) steps.push({ op: 'extend', value: flags.extend });
  return steps;
}

const KEEP = 'keep everything else exactly the same';

/** The edit prompt for one step. These phrasings were tested on FLUX.2 Klein 4B. */
export function promptFor(step: EditStep): string {
  switch (step.op) {
    case 'remove':
      return `remove ${step.value}, fill the space naturally, ${KEEP}`;
    case 'add':
      return `add ${step.value}, matching the lighting and perspective, ${KEEP}`;
    case 'background':
      return `change the background to ${step.value}, keep the subject, their clothes and pose exactly the same`;
    case 'face':
      return `change the face to ${step.value}, keep the outfit, pose and background exactly the same`;
    case 'swap-face':
      return 'replace the face of the person in the first image with the face of the person in the second image, keep their body, clothes, pose and background';
    case 'style':
      return `turn it into ${step.value}, keep the composition and subject`;
    case 'extend':
      return `extend the scene to fill the new frame, continuing the surroundings naturally, keep everything already in the picture exactly the same`;
    case 'custom':
      return step.value;
  }
}

/**
 * The output size for `--extend`: "16:9", "4:3", "1:1", "9:16", "wider", "taller" or "WxH". The
 * picture grows in one direction only, so everything already in it stays the same size.
 */
export function extendSize(width: number, height: number, target: string): { width: number; height: number } {
  const round16 = (n: number) => Math.max(256, Math.min(2048, Math.round(n / 16) * 16));
  const t = target.trim().toLowerCase();
  const exact = /^(\d+)\s*x\s*(\d+)$/.exec(t);
  if (exact) return { width: round16(Number(exact[1])), height: round16(Number(exact[2])) };
  let ratio: number;
  if (t === 'wider') ratio = (width / height) * 1.5;
  else if (t === 'taller') ratio = (width / height) / 1.5;
  else {
    const r = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(t);
    if (!r) throw new Error(`Unknown --extend "${target}". Use a ratio like 16:9, "wider", "taller", or a size like 1536x1024.`);
    ratio = Number(r[1]) / Number(r[2]);
  }
  // Widen when the target is wider than now, otherwise grow taller; then fit within 2048.
  let w = ratio >= width / height ? height * ratio : width;
  let h = ratio >= width / height ? height : width / ratio;
  const scale = Math.min(1, 2048 / Math.max(w, h));
  w *= scale;
  h *= scale;
  return { width: round16(w), height: round16(h) };
}

/**
 * A yes/no question for the vision model and the answer that means the step worked, or null when it
 * can't judge the step reliably. Questions are always phrased positively: vision models misread
 * negations ("is the lamp gone?") far more often than they miss objects.
 */
export function expectationFor(step: EditStep): { question: string; want: boolean } | null {
  switch (step.op) {
    case 'remove':
      return { question: `Is there ${step.value} in this picture?`, want: false };
    case 'add':
      return { question: `Is there ${step.value} in this picture?`, want: true };
    case 'background':
      return { question: `Is the background ${step.value}?`, want: true };
    case 'face':
      return { question: `Does the person have ${step.value}?`, want: true };
    case 'style':
      return { question: `Does this picture look like ${step.value}?`, want: true };
    default:
      return null;
  }
}

const PLANNER_PROMPT =
  'You turn a photo-editing request into steps. Operations: "remove" (value: the thing to remove), "add" (the ' +
  'thing to add, with where), "background" (the new background), "face" (a description of the new face), ' +
  '"swap-face" (only if the user attached a face picture; value: "attached"), "style" (an art style), "extend" ' +
  '(only if they want a wider, taller or bigger frame; value: a ratio like 16:9, or "wider"/"taller"), "custom" ' +
  '(any other edit, as a short instruction). Split combined requests into one step per change, in the order ' +
  'asked. Reply with a JSON array only, like [{"op":"remove","value":"the lamp"}].';

/** Parse and validate the planner's reply. */
export function parsePlan(text: string): EditStep[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('The planner did not return a list of steps.');
  const raw = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('The planner returned no steps.');
  return raw.map((item) => {
    const { op, value } = (item ?? {}) as { op?: unknown; value?: unknown };
    if (typeof op !== 'string' || !(EDIT_OPS as readonly string[]).includes(op)) {
      throw new Error(`The planner used an unknown step "${String(op)}".`);
    }
    return { op: op as EditOpName, value: typeof value === 'string' ? value.trim() : '' };
  });
}

async function chat(host: string, model: string, messages: object[], maxTokens: number): Promise<string> {
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      think: false,
      // Unload straight away: a chat model left in memory slows the image model.
      keep_alive: 0,
      options: { temperature: 0, num_predict: maxTokens },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { message?: { content?: string }; error?: string };
  if (!res.ok || body.error) throw new OllamaError(body.error ?? `Ollama returned HTTP ${res.status}`, res.status);
  return body.message?.content ?? '';
}

export async function planEdits(host: string, model: string, request: string, hasFaceImage: boolean): Promise<EditStep[]> {
  const note = hasFaceImage ? ' (A face picture is attached.)' : ' (No face picture is attached.)';
  const reply = await chat(host, model, [
    { role: 'system', content: PLANNER_PROMPT },
    { role: 'user', content: request + note },
  ], 400);
  const steps = parsePlan(reply);
  return steps.filter((s) => s.op !== 'swap-face' || hasFaceImage).map((s) => (s.op === 'custom' ? { ...s, value: cleanPrompt(s.value) } : s));
}

/** Ask a vision model whether the edit happened. */
export async function checkEdit(
  host: string,
  model: string,
  png: Buffer,
  expectation: { question: string; want: boolean },
): Promise<boolean> {
  const reply = await chat(host, model, [
    { role: 'user', content: `${expectation.question} Answer with one word: yes or no.`, images: [png.toString('base64')] },
  ], 5);
  return /^\W*yes/i.test(reply.trim()) === expectation.want;
}

/** A chat model that can see images, for --check. */
export function pickVisionModel(models: ModelInfo[]): string | null {
  const vision = models
    .filter((m) => m.capabilities.includes('vision') && m.capabilities.includes('completion') && !m.capabilities.includes('image'))
    .sort((a, b) => b.size - a.size);
  return (vision.find((m) => m.size <= 12e9) ?? vision[vision.length - 1])?.name ?? null;
}
