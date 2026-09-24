#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultDeps, resolveImageHost, withImageBackend } from './backend.ts';
import {
  DEFAULT_MODEL,
  DEFAULT_SERVE_PORT,
  DEFAULT_SIZE,
  ENGINE_VERSION,
  HF_CACHE_DIR,
  KNOWN_MODELS,
  LOG_FILE,
  OUTPUT_DIR,
  QUANTIZE_FORMATS,
} from './config.ts';
import { createModel, parseQuantize, resolveSource } from './create.ts';
import { normalizeHost } from './host.ts';
import { runMcpServer } from './mcp.ts';
import { canonicalModel, formatBytes, memoryFit, normalizeModelName } from './models.ts';
import {
  generateImage,
  getVersion,
  listModels,
  OllamaError,
  pullModel,
  type GenerateParams,
  type StepProgress,
} from './ollama.ts';
import { imageFileName, MAX_SEED, parseIntInRange, parseSize, randomSeed } from './options.ts';
import { engineHost, isEngineInstalled, stopEngine, type RuntimeEvents } from './runtime.ts';
import { createImageServer } from './server.ts';

const VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

const HELP = `imagine ${VERSION}: local image generation and editing on your Mac

Usage
  imagine "a cat blasting off from the sun"            generate an image
  imagine "make it night" -i photo.png                 edit an image (up to 4 references)
  imagine serve                                        OpenAI-compatible API on http://127.0.0.1:${DEFAULT_SERVE_PORT}/v1
  imagine mcp                                          MCP server over stdio, for AI apps and agents
  imagine models                                       image models, their sizes, and what fits this Mac
  imagine pull [model]                                 download a model (default ${DEFAULT_MODEL})
  imagine create <name> --from <src> [--quantize fmt]  import a diffusers model, optionally quantized
  imagine status                                       show which engine is doing the work
  imagine stop                                         stop the background engine

Generate options
  -m, --model <name>     model, e.g. flux2-klein:9b-fp4 (default ${DEFAULT_MODEL})
  -i, --image <file>     reference image to edit; repeat for more
  -s, --size <WxH>       image size (default ${DEFAULT_SIZE}, or the input's shape when editing)
      --steps <n>        denoising steps (model default if omitted)
      --seed <n>         seed, to reproduce an image
  -n, --count <n>        how many images to make (default 1)
  -o, --out <path>       folder, or a .png file name (default ${OUTPUT_DIR})
      --open             open the image when it's done

Create options
      --from <src>       local diffusers folder, or Hugging Face repo (owner/name)
  -q, --quantize <fmt>   ${QUANTIZE_FORMATS.map((f) => f.name).join(' | ')} (omit to keep full precision)

Serve options
  -p, --port <n>         port (default ${DEFAULT_SERVE_PORT})
      --bind <address>   address to listen on (default 127.0.0.1)
      --api-key <key>    require "Authorization: Bearer <key>" (also IMAGINE_API_KEY)
      --cors             allow browser apps on other origins to call the API
`;

type Values = ReturnType<typeof parse>['values'];

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      model: { type: 'string', short: 'm' },
      image: { type: 'string', short: 'i', multiple: true },
      size: { type: 'string', short: 's' },
      steps: { type: 'string' },
      seed: { type: 'string' },
      count: { type: 'string', short: 'n' },
      out: { type: 'string', short: 'o' },
      open: { type: 'boolean' },
      force: { type: 'boolean' },
      from: { type: 'string' },
      quantize: { type: 'string', short: 'q' },
      port: { type: 'string', short: 'p' },
      bind: { type: 'string' },
      'api-key': { type: 'string' },
      cors: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv);
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return values.help ? 0 : 1;
  }

  // A command is only a command when it's the whole instruction, so `imagine "serve pizza"` is a prompt.
  const [first, second] = positionals;
  const only = positionals.length === 1;
  if (first === 'serve' && only) return serve(values);
  if (first === 'mcp' && only) return mcp();
  if (first === 'models' && only) return models();
  if (first === 'status' && only) return status();
  if (first === 'stop' && only) return stop();
  if (first === 'pull' && positionals.length <= 2) return pull(second ?? DEFAULT_MODEL, values);
  if (first === 'create' && positionals.length === 2 && second) return create(second, values);

  return generate(positionals.join(' '), values);
}

/** Every front end (CLI, API, MCP) generates through this: edits go to the engine, the rest may use your Ollama. */
function imageGenerator(events: RuntimeEvents) {
  return async (params: GenerateParams, onProgress?: (p: StepProgress) => void): Promise<Buffer> => {
    const request = { ...params, model: normalizeModelName(params.model) };
    try {
      return await withImageBackend((host) => generateImage(host, request, onProgress), defaultDeps(events), {
        editing: Boolean(request.images?.length),
      });
    } catch (err) {
      if (err instanceof OllamaError && /not found/i.test(err.message)) {
        throw new Error(`${err.message}. Download it with: imagine pull ${request.model}`);
      }
      throw err;
    }
  };
}

// ── generate ────────────────────────────────────────────────────────────────

async function generate(prompt: string, values: Values): Promise<number> {
  const images = (values.image ?? []).map((file) => {
    if (!existsSync(file)) throw new Error(`Input image not found: ${file}`);
    return readFileSync(file).toString('base64');
  });
  if (images.length > 4) throw new Error('Use at most 4 reference images.');
  // When editing without --size, leave the size unset so the output keeps the input's shape.
  const size = values.size ?? (images.length ? undefined : DEFAULT_SIZE);
  const { width, height } = size ? parseSize(size) : { width: undefined, height: undefined };
  const steps = values.steps ? parseIntInRange(values.steps, '--steps', 1, 100) : undefined;
  const count = values.count ? parseIntInRange(values.count, '--count', 1, 16) : 1;
  const firstSeed = values.seed ? parseIntInRange(values.seed, '--seed', 1, MAX_SEED) : undefined;
  const model = normalizeModelName(values.model ?? DEFAULT_MODEL);

  const ui = createProgress();
  const run = imageGenerator(runtimeEvents(ui));
  const saved: string[] = [];
  for (let i = 0; i < count; i++) {
    const seed = firstSeed !== undefined ? Math.min(firstSeed + i, MAX_SEED) : randomSeed();
    ui.status(count > 1 ? `Loading ${model} (${i + 1}/${count})…` : `Loading ${model}…`);
    const png = await run({ model, prompt, width, height, steps, seed, images }, (p) =>
      ui.bar(images.length ? 'Editing' : 'Generating', p.completed, p.total),
    );
    ui.clear();

    const file = outputPath(values.out, prompt, seed, i, count);
    await writeFile(file, png);
    console.log(file);
    saved.push(file);
  }
  if (values.open) execFile('open', saved);
  return 0;
}

function outputPath(out: string | undefined, prompt: string, seed: number, index: number, count: number): string {
  if (out && extname(out).toLowerCase() === '.png') {
    const file = resolve(count > 1 ? out.replace(/\.png$/i, `-${index + 1}.png`) : out);
    mkdirSync(dirname(file), { recursive: true });
    return file;
  }
  const dir = resolve(out ?? OUTPUT_DIR);
  mkdirSync(dir, { recursive: true });
  return join(dir, imageFileName(dir, prompt, seed));
}

// ── serve / mcp ─────────────────────────────────────────────────────────────

async function listImageModels(events: RuntimeEvents): Promise<string[]> {
  const models = await listModels(await resolveImageHost(defaultDeps(events)));
  return models.filter((m) => m.capabilities.includes('image')).map((m) => m.name);
}

async function serve(values: Values): Promise<number> {
  const port = values.port ? parseIntInRange(values.port, '--port', 1, 65535) : DEFAULT_SERVE_PORT;
  const bind = values.bind ?? '127.0.0.1';
  const apiKey = values['api-key'] ?? process.env.IMAGINE_API_KEY;
  if (!['127.0.0.1', 'localhost', '::1'].includes(bind) && !apiKey) {
    console.error(`Warning: listening on ${bind} with no --api-key, so anyone on your network can use your GPU.`);
  }

  const log = (line: string) => console.error(`${new Date().toLocaleTimeString()}  ${line}`);
  const events: RuntimeEvents = { onStatus: log };
  const generateWith = imageGenerator(events);
  const server = createImageServer({
    defaultModel: DEFAULT_MODEL,
    outputDir: OUTPUT_DIR,
    apiKey,
    cors: values.cors,
    log,
    generate: (params) => generateWith(params),
    listImageModels: () => listImageModels(events),
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(port, bind, done);
  });
  const base = `http://${bind.includes(':') ? `[${bind}]` : bind}:${port}/v1`;
  console.error(`imagine is serving OpenAI-compatible images at ${base}

  curl ${base}/images/generations \\
    -H 'content-type: application/json' \\
    -d '{"prompt": "a lighthouse at dusk", "size": "1024x1024"}'

  OpenAI SDK: new OpenAI({ baseURL: '${base}', apiKey: '${apiKey ? '<your key>' : 'local'}' })

Press Ctrl+C to stop.`);

  await new Promise<void>((done) => process.once('SIGINT', done));
  server.close();
  return 0;
}

/** stdout carries the protocol, so every status line goes to stderr. */
async function mcp(): Promise<number> {
  const events: RuntimeEvents = { onStatus: (message) => console.error(`imagine: ${message}`) };
  await runMcpServer({
    generate: imageGenerator(events),
    listImageModels: () => listImageModels(events),
    defaultModel: DEFAULT_MODEL,
    outputDir: OUTPUT_DIR,
    version: VERSION,
  });
  return 0;
}

// ── models / pull / create ──────────────────────────────────────────────────

async function models(): Promise<number> {
  const ui = createProgress();
  const host = await resolveImageHost(defaultDeps(runtimeEvents(ui)));
  ui.clear();
  const installed = (await listModels(host)).filter((m) => m.capabilities.includes('image'));
  const installedAs = new Map(installed.map((m) => [canonicalModel(m.name), m.name]));
  const ram = totalmem();

  console.log(`This Mac has ${Math.round(ram / 2 ** 30)} GB of memory.\n`);
  console.log(`  ${'MODEL'.padEnd(24)}${'SIZE'.padEnd(10)}${'MEMORY'.padEnd(10)}${'LICENCE'.padEnd(16)}EDITS`);
  for (const m of KNOWN_MODELS) {
    const have = installedAs.get(m.name);
    const mark = have ? '●' : ' ';
    const alias = have && have !== m.name ? `  (installed as ${have})` : have ? '  (installed)' : '';
    console.log(
      `${mark} ${m.name.padEnd(24)}${formatBytes(m.size).padEnd(10)}${memoryFit(m.size, ram).padEnd(10)}` +
        `${m.license.padEnd(16)}${m.edits ? 'yes' : 'no'}${alias}`,
    );
  }

  const others = installed.filter((m) => !KNOWN_MODELS.some((k) => k.name === canonicalModel(m.name)));
  if (others.length) {
    console.log('\nYour own models');
    for (const m of others) {
      console.log(`● ${m.name.padEnd(24)}${formatBytes(m.size).padEnd(10)}${memoryFit(m.size, ram)}`);
    }
  }
  console.log('\n● installed · pull with: imagine pull flux2-klein:4b-fp8');
  return 0;
}

async function pull(name: string, values: Values): Promise<number> {
  const model = normalizeModelName(name);
  const known = KNOWN_MODELS.find((m) => m.name === canonicalModel(model));
  if (known && memoryFit(known.size, totalmem()) === 'too big' && !values.force) {
    throw new Error(
      `${model} needs about ${formatBytes(known.size)} and this Mac has ${Math.round(totalmem() / 2 ** 30)} GB of memory, ` +
        'so it would not load. Pick a smaller variant (see `imagine models`), or pass --force to download anyway.',
    );
  }

  const ui = createProgress();
  const host = await resolveImageHost(defaultDeps(runtimeEvents(ui)));
  await pullModel(host, model, (p) => {
    if (p.total && p.completed !== undefined) ui.bar(`Pulling ${model}`, p.completed, p.total, formatBytes);
    else ui.status(p.status);
  });
  ui.clear();
  console.log(`Pulled ${model}`);
  return 0;
}


async function create(name: string, values: Values): Promise<number> {
  if (!values.from) throw new Error('Say where the model comes from: --from <folder or owner/name>.');
  const quantize = values.quantize ? parseQuantize(values.quantize) : undefined;

  const ui = createProgress();
  const source = await resolveSource(values.from, (p) =>
    ui.bar('Downloading from Hugging Face', p.overallReceived, p.overallTotal, formatBytes),
  );
  ui.clear();
  console.error(`Creating ${name} from ${source.dir}${quantize ? ` as ${quantize}` : ' at full precision'}…`);
  await createModel(name, source.dir, quantize, runtimeEvents(ui));
  ui.clear();

  console.log(`Created ${name}. Try: imagine "a lighthouse at dusk" -m ${name}`);
  if (source.downloaded) {
    console.error(`The downloaded source is still in ${source.dir}. Delete it with: rm -rf "${source.dir}"`);
  }
  return 0;
}

// ── status / stop ───────────────────────────────────────────────────────────

async function status(): Promise<number> {
  const mainHost = normalizeHost(process.env.OLLAMA_HOST);
  const [mainVersion, engineVersion] = await Promise.all([getVersion(mainHost), getVersion(engineHost())]);
  const deps = defaultDeps();

  console.log(`Your Ollama      ${mainVersion ? `${mainVersion} at ${mainHost}` : `not running at ${mainHost}`}`);
  if (mainVersion) {
    console.log(`  image support  ${deps.isUnsupported(mainVersion) ? 'no (removed in 0.32.6)' : 'not ruled out yet'}`);
  }
  console.log(
    `Image engine     ${ENGINE_VERSION}, ${isEngineInstalled() ? 'installed' : 'not installed yet'}, ` +
      `${engineVersion ? `running at ${engineHost()}${engineVersion === ENGINE_VERSION ? '' : ` (found ${engineVersion})`}` : 'stopped'}`,
  );
  if (deps.overrideHost) console.log(`Override         IMAGINE_OLLAMA_HOST=${deps.overrideHost}`);
  console.log(`Images saved to  ${OUTPUT_DIR}`);
  console.log(`Downloads        ${HF_CACHE_DIR}`);
  console.log(`Engine log       ${LOG_FILE}`);
  return 0;
}

async function stop(): Promise<number> {
  const result = await stopEngine();
  const messages = {
    stopped: 'Stopped the image engine.',
    'not-running': 'The image engine is not running.',
    'not-ours': `Something on ${engineHost()} is running, but imagine didn't start it, so it was left alone.`,
  } as const;
  console.log(messages[result]);
  return 0;
}

// ── terminal output ─────────────────────────────────────────────────────────

interface Progress {
  status(message: string): void;
  bar(label: string, done: number, total: number, format?: (n: number) => string): void;
  clear(): void;
}

/** One rewritable status line on stderr, so stdout stays clean for scripts (it only prints file paths). */
function createProgress(stream = process.stderr): Progress {
  const tty = stream.isTTY === true;
  let shown = false;
  const render = (line: string) => {
    stream.write(`\r\x1b[2K${line}`);
    shown = true;
  };
  return {
    status(message) {
      if (tty) render(message);
      else stream.write(`${message}\n`);
    },
    bar(label, done, total, format = String) {
      if (!tty) return;
      const width = 24;
      const filled = total > 0 ? Math.min(width, Math.round((done / total) * width)) : 0;
      render(`${label} ${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${format(done)}/${format(total)}`);
    },
    clear() {
      if (tty && shown) stream.write('\r\x1b[2K');
      shown = false;
    },
  };
}

function runtimeEvents(ui: Progress): RuntimeEvents {
  return {
    onStatus: (message) => ui.status(message),
    onDownload: (received, total) => ui.bar('Downloading engine', received, total, formatBytes),
  };
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (process.stderr.isTTY) process.stderr.write('\r\x1b[2K');
    console.error(`imagine: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
