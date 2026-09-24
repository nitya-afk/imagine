/** Minimal client for the parts of the Ollama HTTP API that image generation uses. */

export class OllamaError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'OllamaError';
    this.status = status;
  }
}

const IMAGE_GEN_REMOVED = /image generation models are not currently supported/i;

/** True when the server is an Ollama build (>= 0.32.6) that ships without image generation. */
export function isImageGenUnsupported(err: unknown): boolean {
  return err instanceof OllamaError && IMAGE_GEN_REMOVED.test(err.message);
}

export async function getVersion(host: string, timeoutMs = 1500): Promise<string | null> {
  try {
    const res = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

export interface ModelInfo {
  name: string;
  size: number;
  capabilities: string[];
}

export async function listModels(host: string): Promise<ModelInfo[]> {
  const res = await fetch(`${host}/api/tags`);
  if (!res.ok) throw await errorFrom(res);
  const body = (await res.json()) as {
    models?: Array<{ name: string; size?: number; capabilities?: string[] }>;
  };
  return (body.models ?? []).map((m) => ({
    name: m.name,
    size: m.size ?? 0,
    capabilities: m.capabilities ?? [],
  }));
}

export interface GenerateParams {
  model: string;
  prompt: string;
  width?: number;
  height?: number;
  steps?: number;
  seed: number;
  /** Base64-encoded reference images. Their presence turns the request into an edit. */
  images?: string[];
}

export interface StepProgress {
  completed: number;
  total: number;
}

/** Generate one image and return the PNG bytes. */
export async function generateImage(
  host: string,
  params: GenerateParams,
  onProgress?: (progress: StepProgress) => void,
): Promise<Buffer> {
  const res = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: params.model,
      prompt: params.prompt,
      width: params.width,
      height: params.height,
      steps: params.steps,
      images: params.images?.length ? params.images : undefined,
      options: { seed: params.seed },
      stream: true,
    }),
  });
  if (!res.ok) throw await errorFrom(res);

  let image: string | undefined;
  for await (const msg of ndjson(res)) {
    if (typeof msg.error === 'string') throw new OllamaError(msg.error, 500);
    if (typeof msg.total === 'number' && msg.total > 0) {
      onProgress?.({ completed: Number(msg.completed ?? 0), total: msg.total });
    }
    if (msg.done === true && typeof msg.image === 'string') image = msg.image;
    // The image runner reports failures as a final "error: …" message instead of an HTTP error.
    if (msg.done === true && typeof msg.response === 'string' && msg.response.startsWith('error:')) {
      throw new OllamaError(msg.response.slice('error:'.length).trim(), 500);
    }
  }
  if (!image) throw new OllamaError('Ollama finished without returning an image', 502);
  return Buffer.from(image, 'base64');
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

export async function pullModel(
  host: string,
  model: string,
  onProgress?: (progress: PullProgress) => void,
): Promise<void> {
  const res = await fetch(`${host}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!res.ok) throw await errorFrom(res);
  for await (const msg of ndjson(res)) {
    if (typeof msg.error === 'string') throw new OllamaError(msg.error, 500);
    onProgress?.({
      status: String(msg.status ?? ''),
      completed: typeof msg.completed === 'number' ? msg.completed : undefined,
      total: typeof msg.total === 'number' ? msg.total : undefined,
    });
  }
}

async function errorFrom(res: Response): Promise<OllamaError> {
  const text = await res.text().catch(() => '');
  let message = text || `Ollama returned HTTP ${res.status}`;
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === 'string') message = body.error;
  } catch {
    // Not JSON; keep the raw text.
  }
  return new OllamaError(message, res.status);
}

/** Read a newline-delimited JSON stream. Image payloads arrive as one very long line. */
async function* ndjson(res: Response): AsyncGenerator<Record<string, unknown>> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as Record<string, unknown>;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer) as Record<string, unknown>;
}
