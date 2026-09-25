/**
 * `--enhance`: a local chat model in Ollama turns a short idea ("a cat astronaut") into a detailed
 * image prompt. Fully offline, like the rest of imagine.
 */
import { normalizeHost } from './host.ts';
import { getVersion, listModels, OllamaError, type ModelInfo } from './ollama.ts';

const SYSTEM_PROMPT =
  'You write prompts for a text-to-image model. Turn the user\'s idea into one vivid prompt: the subject, ' +
  'setting, composition, lighting, style and mood, in plain descriptive English. Keep every detail the user ' +
  'asked for and don\'t add text or lettering unless they asked for it. Reply with the prompt only, under 70 ' +
  'words, with no quotes, labels or explanations.';

/** Largest chat model that loads comfortably (under 12 GB); otherwise the smallest one there is. */
export function pickChatModel(models: ModelInfo[]): string | null {
  const chat = models.filter((m) => m.capabilities.includes('completion') && !m.capabilities.includes('image'));
  if (chat.length === 0) return null;
  const comfortable = chat.filter((m) => m.size <= 12e9).sort((a, b) => b.size - a.size);
  return (comfortable[0] ?? chat.sort((a, b) => a.size - b.size)[0])!.name;
}

/** Strip what chat models wrap around an answer: reasoning, labels, quotes, extra lines. */
export function cleanPrompt(text: string): string {
  let prompt = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  prompt = prompt.replace(/^(here(?:'s| is)[^:\n]*:|(?:image |enhanced |final )?prompt:)\s*/i, '');
  prompt = prompt.split(/\n\s*\n/)[0]!.replace(/\s+/g, ' ').trim();
  prompt = prompt.replace(/^["'“”*]+|["'“”*]+$/g, '').trim();
  return prompt.length > 600 ? prompt.slice(0, 600).replace(/\s+\S*$/, '') : prompt;
}

export async function enhancePrompt(host: string, model: string, idea: string): Promise<string> {
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: idea },
      ],
      stream: false,
      think: false,
      // Unload right after answering: a chat model left in memory slows the image model that runs next.
      keep_alive: 0,
      options: { temperature: 0.7, num_predict: 256 },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { message?: { content?: string }; error?: string };
  if (!res.ok || body.error) throw new OllamaError(body.error ?? `Ollama returned HTTP ${res.status}`, res.status);
  const prompt = cleanPrompt(body.message?.content ?? '');
  if (!prompt) throw new Error(`${model} returned an empty prompt. Try again, or leave out --enhance.`);
  return prompt;
}

/** Enhance with a chat model from the user's own Ollama (the engine only runs image models). */
export async function enhanceIdea(idea: string, onStatus?: (message: string) => void): Promise<string> {
  const host = normalizeHost(process.env.OLLAMA_HOST);
  if (!(await getVersion(host))) {
    throw new Error(`--enhance uses a chat model in Ollama, but Ollama isn't running at ${host}. Start Ollama, or leave out --enhance.`);
  }
  const model = process.env.IMAGINE_ENHANCE_MODEL ?? pickChatModel(await listModels(host));
  if (!model) throw new Error('--enhance needs a chat model in Ollama. Install one, for example: ollama pull gemma4:12b');
  onStatus?.(`Writing the prompt with ${model}…`);
  return enhancePrompt(host, model, idea);
}
