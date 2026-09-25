/**
 * `imagine ui`: a small local web app to create and edit images. It listens on 127.0.0.1 only, and
 * every API call needs the per-session token baked into the page, so other websites can't drive it.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { describeStep, runEdit, stepsFromFlags } from './edit.ts';
import { enhanceIdea } from './enhance.ts';
import type { Generate } from './generator.ts';
import { prepareImage } from './images.ts';
import { imageFileName, MAX_SEED, parseIntInRange, parseSize, randomSeed } from './options.ts';
import { readMetadata } from './png.ts';

export interface UiDeps {
  version: string;
  outputDir: string;
  defaultModel: string;
  generate: Generate;
  listImageModels: () => Promise<string[]>;
  /** Defaults to the real prompt enhancer; tests replace it. */
  enhance?: (idea: string, onStatus: (message: string) => void) => Promise<string>;
}

type Event = Record<string, unknown> & { type: string };

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_JSON = 100_000;
const MAX_FORM = 60_000_000;

export function createUiServer(deps: UiDeps): { server: Server; token: string } {
  const token = randomBytes(16).toString('hex');
  const page = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8')
    .replaceAll('__IMAGINE_TOKEN__', token)
    .replaceAll('__IMAGINE_VERSION__', deps.version)
    .replaceAll('__IMAGINE_MODEL__', deps.defaultModel);
  const enhance = deps.enhance ?? enhanceIdea;

  // One GPU job at a time; the others wait their turn.
  let queue: Promise<unknown> = Promise.resolve();
  let waiting = 0;
  const enqueue = <T>(task: () => Promise<T>, onWait: () => void): Promise<T> => {
    if (waiting > 0) onWait();
    waiting++;
    const run = queue.then(task, task).finally(() => waiting--);
    queue = run.catch(() => undefined);
    return run;
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (res.headersSent) return void res.end();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Something went wrong.' }));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A page on another site can't reach us through DNS tricks: the Host must be this machine.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new HttpError(403, 'Forbidden.');

    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return void res.end(page);
    }
    if (req.method === 'GET' && path.startsWith('/images/')) return serveImage(decodeURIComponent(path.slice(8)), res);

    if (!path.startsWith('/api/')) throw new HttpError(404, 'Not found.');
    const given = Buffer.from(String(req.headers['x-imagine-token'] ?? ''));
    if (given.length !== token.length || !timingSafeEqual(given, Buffer.from(token))) {
      throw new HttpError(401, 'Reload the page: this session has ended.');
    }

    if (req.method === 'GET' && path === '/api/models') {
      return json(res, { models: await deps.listImageModels(), defaultModel: deps.defaultModel });
    }
    if (req.method === 'GET' && path === '/api/gallery') return json(res, { images: gallery() });
    if (req.method === 'DELETE' && path === '/api/gallery') return json(res, { deleted: deleteAll() });
    if (req.method === 'DELETE' && path.startsWith('/api/images/')) {
      unlinkSync(galleryFile(decodeURIComponent(path.slice(12))));
      return json(res, { deleted: 1 });
    }
    if (req.method === 'POST' && path === '/api/generate') return generate(req, res);
    if (req.method === 'POST' && path === '/api/edit') return edit(req, res);
    throw new HttpError(404, 'Not found.');
  }

  async function generate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const text = (await readBody(req, MAX_JSON)).toString('utf8');
    const body = invalid(() => JSON.parse(text || '{}') as Record<string, unknown>);
    const idea = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!idea) throw new HttpError(400, 'Describe the image you want.');
    const { width, height } = invalid(() => parseSize(typeof body.size === 'string' ? body.size : '1024x1024'));
    const count = invalid(() => parseIntInRange(Number(body.count ?? 1), 'count', 1, 4));
    const firstSeed = body.seed ? invalid(() => parseIntInRange(Number(body.seed), 'seed', 1, MAX_SEED)) : undefined;
    const model = typeof body.model === 'string' && body.model ? body.model : deps.defaultModel;

    const send = stream(res);
    await enqueue(
      async () => {
        try {
          const prompt = body.enhance ? await enhance(idea, (message) => send({ type: 'status', message })) : idea;
          if (body.enhance) send({ type: 'prompt', prompt });
          for (let i = 0; i < count; i++) {
            const seed = firstSeed !== undefined ? Math.min(firstSeed + i, MAX_SEED) : randomSeed();
            const label = count > 1 ? `Image ${i + 1} of ${count}` : 'Generating';
            send({ type: 'status', message: `${label}…` });
            const png = await deps.generate(
              { model, prompt, width, height, seed },
              (p) => send({ type: 'progress', label, completed: p.completed, total: p.total }),
              body.enhance ? idea : undefined,
            );
            send({ type: 'image', image: await save(png, idea, seed) });
          }
          send({ type: 'done' });
        } catch (err) {
          send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
        res.end();
      },
      () => send({ type: 'status', message: 'Waiting for the image being made…' }),
    );
  }

  async function edit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const form = await readForm(req);
    const field = (name: string) => {
      const value = form.get(name);
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };
    const file = async (name: string) => {
      const value = form.get(name);
      return value && typeof value !== 'string' && value.size > 0 ? Buffer.from(await value.arrayBuffer()) : undefined;
    };
    // The photo is an upload, or one of the pictures already in the gallery ("keep editing").
    let photo = await file('photo');
    const from = field('from');
    if (!photo && from) photo = readFileSync(galleryFile(from));
    if (!photo) throw new HttpError(400, 'Add a photo to edit.');
    const face = await file('face');
    const request = field('request');
    const steps = stepsFromFlags({
      remove: field('remove') ? [field('remove')!] : undefined,
      add: field('add') ? [field('add')!] : undefined,
      background: field('background'),
      style: field('style'),
      face: field('faceDescription'),
      swapFace: face ? 'the uploaded face' : undefined,
      extend: field('extend'),
    });
    const seed = field('seed') ? invalid(() => parseIntInRange(Number(field('seed')), 'seed', 1, MAX_SEED)) : undefined;

    const send = stream(res);
    await enqueue(
      async () => {
        try {
          const result = await runEdit({
            photo: await prepareImage(photo!, 'the photo', { png: true }),
            face: face ? await prepareImage(face, 'the face photo') : undefined,
            request,
            steps,
            check: field('check') === 'true',
            seed,
            model: field('model') ?? deps.defaultModel,
            generate: deps.generate,
            events: {
              status: (message) => send({ type: 'status', message }),
              progress: (label, completed, total) => send({ type: 'progress', label, completed, total }),
              plan: (planned) => send({ type: 'plan', steps: planned.map(describeStep) }),
              stepDone: (step) =>
                send({
                  type: 'step',
                  index: step.index,
                  total: step.total,
                  seconds: Math.round(step.seconds),
                  checked: step.checked,
                  preview: `data:image/png;base64,${step.image.toString('base64')}`,
                }),
            },
          });
          const label = request ?? result.steps.map(describeStep).join(', ');
          send({ type: 'image', image: await save(result.image, label, result.seed) });
          send({ type: 'done' });
        } catch (err) {
          send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
        res.end();
      },
      () => send({ type: 'status', message: 'Waiting for the image being made…' }),
    );
  }

  async function save(png: Buffer, label: string, seed: number) {
    mkdirSync(deps.outputDir, { recursive: true });
    const name = imageFileName(deps.outputDir, label, seed);
    await writeFile(join(deps.outputDir, name), png);
    return describe(name, png);
  }

  function describe(name: string, png: Buffer) {
    const meta = readMetadata(png);
    return {
      name,
      url: `/images/${encodeURIComponent(name)}`,
      prompt: meta?.prompt,
      idea: meta?.idea,
      seed: meta?.seed,
      model: meta?.model,
      width: meta?.width,
      height: meta?.height,
      edit: meta?.edit ?? false,
    };
  }

  /** The newest images in the output folder, with the settings saved inside them. */
  function gallery() {
    if (!existsSync(deps.outputDir)) return [];
    return readdirSync(deps.outputDir)
      .filter((name) => name.endsWith('.png'))
      .map((name) => ({ name, time: statSync(join(deps.outputDir, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time)
      .slice(0, 60)
      .map(({ name }) => describe(name, readFileSync(join(deps.outputDir, name))));
  }

  /** Every picture imagine made in the output folder, and nothing else that happens to be there. */
  function deleteAll(): number {
    if (!existsSync(deps.outputDir)) return 0;
    let deleted = 0;
    for (const name of readdirSync(deps.outputDir)) {
      if (!name.endsWith('.png')) continue;
      const file = join(deps.outputDir, name);
      if (!readMetadata(readFileSync(file))?.generator?.startsWith('imagine')) continue;
      unlinkSync(file);
      deleted++;
    }
    return deleted;
  }

  function galleryFile(name: string): string {
    const safe = basename(name);
    const file = join(deps.outputDir, safe);
    if (!safe.endsWith('.png') || !existsSync(file)) throw new HttpError(404, 'That picture is no longer in the gallery.');
    return file;
  }

  function serveImage(name: string, res: ServerResponse): void {
    const file = galleryFile(name);
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=31536000, immutable' });
    createReadStream(file).pipe(res);
  }

  return { server, token };
}

/** A setting the person typed that we can't use is their mistake (400), not a server failure. */
function invalid<T>(read: () => T): T {
  try {
    return read();
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : 'That setting is not valid.');
  }
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Progress as newline-delimited JSON, so the page can show each step as it happens. */
function stream(res: ServerResponse): (event: Event) => void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  return (event) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'That file is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readForm(req: IncomingMessage): Promise<FormData> {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('multipart/form-data')) throw new HttpError(400, 'Expected a form upload.');
  const body = await readBody(req, MAX_FORM);
  return new Response(new Uint8Array(body), { headers: { 'content-type': type } }).formData();
}
