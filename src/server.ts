/**
 * An OpenAI-compatible images API (POST /v1/images/generations and /v1/images/edits) backed by
 * local models, so anything built on the OpenAI SDK can generate and edit images on this Mac.
 */
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import type { GenerateParams } from './ollama.ts';
import { imageFileName, MAX_SEED, parseIntInRange, parseSize, randomSeed } from './options.ts';

export interface ServerDeps {
  generate: (params: GenerateParams) => Promise<Buffer>;
  listImageModels: () => Promise<string[]>;
  defaultModel: string;
  outputDir: string;
  apiKey?: string;
  cors?: boolean;
  log?: (line: string) => void;
}

export interface GenerationRequest {
  prompt: string;
  model: string;
  n: number;
  /** Unset for an edit without a size: the output keeps the input image's aspect ratio. */
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  responseFormat: 'b64_json' | 'url';
}

const MAX_PROMPT_LENGTH = 4000;
const MAX_JSON_BYTES = 1_000_000;
const MAX_FORM_BYTES = 50_000_000;
const MAX_IMAGES_PER_REQUEST = 4;
const MAX_INPUT_IMAGES = 4;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Validate an OpenAI images request. Fields we can't honour (quality, style…) are ignored. */
export function parseGenerationRequest(
  body: unknown,
  defaultModel: string,
  options: { edit?: boolean } = {},
): GenerationRequest {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'Request body must be a JSON object.');
  const b = body as Record<string, unknown>;

  if (typeof b.prompt !== 'string' || !b.prompt.trim()) throw new HttpError(400, '`prompt` is required.');
  if (b.prompt.length > MAX_PROMPT_LENGTH) {
    throw new HttpError(400, `\`prompt\` must be at most ${MAX_PROMPT_LENGTH} characters.`);
  }

  // Clients written for OpenAI send their own model names; map those to the local default.
  let model = defaultModel;
  if (b.model !== undefined && b.model !== '') {
    if (typeof b.model !== 'string') throw new HttpError(400, '`model` must be a string.');
    if (!/^(dall-e|gpt-image)/i.test(b.model)) model = b.model;
  }

  const size = b.size === undefined || b.size === 'auto' ? undefined : b.size;
  if (size !== undefined && typeof size !== 'string') {
    throw new HttpError(400, '`size` must be a string like "1024x1024".');
  }

  const format = b.response_format ?? 'b64_json';
  if (format !== 'b64_json' && format !== 'url') {
    throw new HttpError(400, '`response_format` must be "b64_json" or "url".');
  }

  const optionalInt = (value: unknown, name: string, max: number) =>
    value === undefined || value === '' ? undefined : parseIntInRange(value as number, name, 1, max);

  try {
    const dims = size ? parseSize(size) : options.edit ? undefined : parseSize('1024x1024');
    return {
      prompt: b.prompt,
      model,
      n: optionalInt(b.n, '`n`', MAX_IMAGES_PER_REQUEST) ?? 1,
      width: dims?.width,
      height: dims?.height,
      steps: optionalInt(b.steps, '`steps`', 100),
      seed: optionalInt(b.seed, '`seed`', MAX_SEED),
      responseFormat: format,
    };
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

export function createImageServer(deps: ServerDeps): Server {
  // The engine runs one generation at a time; queue here so requests don't time out inside it.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  return createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      deps.log?.(`${req.method} ${req.url} ${res.statusCode} ${((Date.now() - started) / 1000).toFixed(1)}s`);
    });
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : 'Image generation failed.';
      sendJson(res, status, {
        error: { message, type: status < 500 ? 'invalid_request_error' : 'server_error' },
      });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (deps.cors) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
    }

    const path = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && path.startsWith('/images/')) {
      serveImage(path.slice('/images/'.length), res);
      return;
    }

    checkApiKey(req);

    if (req.method === 'GET' && path === '/v1/models') {
      const models = await deps.listImageModels();
      sendJson(res, 200, {
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'ollama' })),
      });
      return;
    }

    if (req.method === 'POST' && path === '/v1/images/generations') {
      const body = await readBody(req, MAX_JSON_BYTES);
      let json: unknown;
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        throw new HttpError(400, 'Request body must be valid JSON.');
      }
      await respondWithImages(req, res, parseGenerationRequest(json, deps.defaultModel));
      return;
    }

    if (req.method === 'POST' && path === '/v1/images/edits') {
      const form = await readForm(req);
      if (form.has('mask')) {
        throw new HttpError(400, 'Masks are not supported. Describe the change in the prompt instead.');
      }
      const files = [...form.getAll('image'), ...form.getAll('image[]')].filter(
        (value): value is File => typeof value !== 'string',
      );
      if (files.length === 0) throw new HttpError(400, 'Attach at least one `image` file.');
      if (files.length > MAX_INPUT_IMAGES) throw new HttpError(400, `Attach at most ${MAX_INPUT_IMAGES} images.`);
      const images = await Promise.all(files.map(async (f) => Buffer.from(await f.arrayBuffer()).toString('base64')));

      const fields: Record<string, unknown> = {};
      for (const [key, value] of form) if (typeof value === 'string') fields[key] = value;
      await respondWithImages(req, res, parseGenerationRequest(fields, deps.defaultModel, { edit: true }), images);
      return;
    }

    throw new HttpError(404, `No route for ${req.method} ${path}.`);
  }

  async function respondWithImages(
    req: IncomingMessage,
    res: ServerResponse,
    request: GenerationRequest,
    images?: string[],
  ): Promise<void> {
    const data: Array<{ b64_json: string } | { url: string }> = [];
    for (let i = 0; i < request.n; i++) {
      const seed = request.seed !== undefined ? Math.min(request.seed + i, MAX_SEED) : randomSeed();
      const png = await enqueue(() =>
        deps.generate({
          model: request.model,
          prompt: request.prompt,
          width: request.width,
          height: request.height,
          steps: request.steps,
          seed,
          images,
        }),
      );
      if (request.responseFormat === 'url') {
        mkdirSync(deps.outputDir, { recursive: true });
        const name = imageFileName(deps.outputDir, request.prompt, seed);
        await writeFile(join(deps.outputDir, name), png);
        data.push({ url: `http://${req.headers.host ?? 'localhost'}/images/${encodeURIComponent(name)}` });
      } else {
        data.push({ b64_json: png.toString('base64') });
      }
    }
    sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data });
  }

  function checkApiKey(req: IncomingMessage): void {
    if (!deps.apiKey) return;
    const given = Buffer.from(/^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '');
    const expected = Buffer.from(deps.apiKey);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HttpError(401, 'Missing or invalid API key.');
    }
  }

  function serveImage(rawName: string, res: ServerResponse): void {
    const name = basename(decodeURIComponent(rawName));
    const file = join(deps.outputDir, name);
    if (!name.endsWith('.png') || !existsSync(file)) throw new HttpError(404, 'Image not found.');
    res.writeHead(200, { 'content-type': 'image/png' });
    createReadStream(file).pipe(res);
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Parse multipart/form-data with the platform's own parser. */
async function readForm(req: IncomingMessage): Promise<FormData> {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('multipart/form-data')) {
    throw new HttpError(400, 'Send multipart/form-data with an `image` file and a `prompt`.');
  }
  const body = await readBody(req, MAX_FORM_BYTES);
  try {
    return await new Response(new Uint8Array(body), { headers: { 'content-type': type } }).formData();
  } catch {
    throw new HttpError(400, 'Could not parse the multipart form.');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
