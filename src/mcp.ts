/**
 * A Model Context Protocol server over stdio, so apps and agents that speak MCP can generate and
 * edit images on this Mac. Each message is one line of JSON-RPC 2.0.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_SIZE } from './config.ts';
import type { GenerateParams, StepProgress } from './ollama.ts';
import { imageFileName, MAX_SEED, parseIntInRange, parseSize, randomSeed } from './options.ts';

export interface McpDeps {
  /** Generates one image (edit when params.images is non-empty) and returns PNG bytes. */
  generate: (params: GenerateParams, onProgress?: (p: StepProgress) => void) => Promise<Buffer>;
  listImageModels: () => Promise<string[]>;
  defaultModel: string;
  outputDir: string;
  version: string;
}

const LATEST_PROTOCOL = '2025-11-25';
/** Newest first. A client on an older revision ignores the fields it predates, like `annotations`. */
const PROTOCOL_VERSIONS = [LATEST_PROTOCOL, '2025-06-18', '2025-03-26', '2024-11-05'];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const MAX_EDIT_IMAGES = 4;

type JsonObject = Record<string, unknown>;

interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  structuredContent?: { path: string; seed: number; model: string };
  isError?: boolean;
}

/** Answered as a JSON-RPC error. Errors thrown while a tool runs become `isError` results instead. */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** Serve MCP over newline-delimited JSON-RPC 2.0 until `input` ends. */
export async function runMcpServer(
  deps: McpDeps,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const outputDir = resolve(expandHome(deps.outputDir));
  const tools = describeTools(deps.defaultModel, outputDir);

  // The engine makes one image at a time, so queue here as the HTTP server does. Saving happens in
  // the same turn, so two images can never claim the same file name.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  // `output` carries nothing but JSON-RPC messages. A client that quits mid-generation closes the
  // pipe, and what's left to send is dropped rather than crashing the process.
  let closed = false;
  let flushed = Promise.resolve();
  output.on('error', () => {
    closed = true;
  });
  const send = (message: object): void => {
    if (closed) return;
    flushed = new Promise((done) => output.write(`${JSON.stringify(message)}\n`, () => done()));
  };

  // Every line is handled as it arrives, so a ping gets its answer while an image is generating.
  const inFlight = new Set<Promise<void>>();
  try {
    for await (const line of readLines(input)) {
      const task = handleLine(line).finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
  } finally {
    await Promise.all(inFlight);
    // Writes to a pipe are asynchronous on macOS. Wait for the last reply to go out, or a caller
    // that exits straight away would cut it off.
    await flushed;
  }

  async function handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send(failure(null, PARSE_ERROR, 'Parse error: each line must be one JSON-RPC message.'));
      return;
    }
    const reply = await respond(message);
    if (reply) send(reply);
  }

  /** The reply to one message, if it gets one. */
  async function respond(message: unknown): Promise<object | undefined> {
    if (!isObject(message)) return failure(null, INVALID_REQUEST, 'Invalid request: expected a JSON-RPC object.');
    const { id, method } = message;
    // Notifications carry no id and never get a reply. Nor do responses: this server sends no requests.
    if (id === undefined || (method === undefined && ('result' in message || 'error' in message))) return undefined;
    const validId = typeof id === 'string' || typeof id === 'number';
    if (!validId || typeof method !== 'string' || message.jsonrpc !== '2.0') {
      return failure(validId ? id : null, INVALID_REQUEST, 'Invalid request.');
    }
    try {
      return { jsonrpc: '2.0', id, result: await dispatch(method, message.params) };
    } catch (err) {
      const code = err instanceof RpcError ? err.code : INTERNAL_ERROR;
      return failure(id, code, err instanceof Error ? err.message : 'Internal error.');
    }
  }

  async function dispatch(method: string, params: unknown): Promise<object> {
    if (params !== undefined && !isObject(params)) throw new RpcError(INVALID_PARAMS, 'params must be an object.');
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSIONS.find((v) => v === params?.protocolVersion) ?? LATEST_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'imagine', version: deps.version },
          instructions:
            `Generates and edits images locally on this Mac, saving each PNG to ${outputDir} and returning it.`,
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools };
      case 'tools/call':
        return callTool(params ?? {});
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async function callTool(params: JsonObject): Promise<ToolResult> {
    const tool = tools.find((t) => t.name === params.name);
    if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
    try {
      const args = params.arguments ?? {};
      if (!isObject(args)) throw new Error('Tool arguments must be an object.');
      const accepted = Object.keys(tool.inputSchema.properties);
      const extra = Object.keys(args).find((key) => !accepted.includes(key));
      if (extra) {
        throw new Error(`Unknown argument "${extra}" for ${tool.name}. Accepted: ${accepted.join(', ') || 'none'}.`);
      }
      if (tool.name === 'list_image_models') return await installedModels();
      const request = await parseImageArgs(args, tool.name === 'edit_image', deps.defaultModel);
      return await makeImage(request, progressReporter(params._meta));
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  }

  async function makeImage(params: GenerateParams, onProgress?: (p: StepProgress) => void): Promise<ToolResult> {
    const saved = await enqueue(async () => {
      const png = await deps.generate(params, onProgress);
      await mkdir(outputDir, { recursive: true });
      const path = join(outputDir, imageFileName(outputDir, params.prompt, params.seed));
      await writeFile(path, png);
      return { png, path };
    });
    const size = params.width ? `${params.width}x${params.height}` : 'input size';
    return {
      content: [
        { type: 'text', text: `Saved to ${saved.path} (seed ${params.seed}, ${size})` },
        { type: 'image', data: saved.png.toString('base64'), mimeType: 'image/png' },
      ],
      structuredContent: { path: saved.path, seed: params.seed, model: params.model },
    };
  }

  async function installedModels(): Promise<ToolResult> {
    const models = await deps.listImageModels();
    const text = models.length
      ? `Installed image models (default ${deps.defaultModel}):\n${models.map((name) => `- ${name}`).join('\n')}`
      : `No image models are installed yet. Install one in a terminal with: imagine pull ${deps.defaultModel}`;
    return { content: [{ type: 'text', text }] };
  }

  /** Engine steps as progress notifications, when the request asked for them with a token. */
  function progressReporter(meta: unknown): ((p: StepProgress) => void) | undefined {
    const token = isObject(meta) ? meta.progressToken : undefined;
    if (typeof token !== 'string' && typeof token !== 'number') return undefined;
    let last = -1;
    return ({ completed, total }) => {
      if (completed <= last) return; // MCP requires progress to go up with every notification.
      last = completed;
      send({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: token, progress: completed, total, message: 'Generating' },
      });
    };
  }
}

/** The tools/list entries. Their descriptions are what a model reads when deciding what to call. */
function describeTools(defaultModel: string, outputDir: string) {
  const sizeRule = 'WIDTHxHEIGHT in pixels, each side 256 to 2048 and a multiple of 16';
  const common = {
    seed: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_SEED,
      description:
        'Random seed. Leave it out for a fresh image; reuse one with the same prompt and settings to reproduce it.',
    },
    steps: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: "Denoising steps. Leave it out to use the model's default, which suits most images.",
    },
    model: {
      type: 'string',
      default: defaultModel,
      description: `Installed image model to use (see list_image_models). Default ${defaultModel}.`,
    },
  };
  return [
    {
      name: 'generate_image',
      description:
        `Generate an image from a text prompt with a local image model on this Mac. The PNG is saved to ${outputDir} ` +
        'and returned along with its path and seed. An image takes from a few seconds to a few minutes (longest the ' +
        'first time, while the model loads), and requests run one at a time.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'What the image should show, in plain language: subject, setting, style, lighting, composition.',
          },
          size: {
            type: 'string',
            default: DEFAULT_SIZE,
            description: `${sizeRule}, for example 1024x1024 (square), 1536x1024 (landscape) or 1024x1536 (portrait).`,
          },
          ...common,
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      annotations: { title: 'Generate image', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'edit_image',
      description:
        'Edit images with a text instruction using a local image model on this Mac: restyle a picture, add or remove ' +
        `things, or combine up to ${MAX_EDIT_IMAGES} images into one. The input files are left untouched; the result ` +
        `is saved to ${outputDir} as a new PNG and returned along with its path and seed.`,
      inputSchema: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              'The edit to make, for example "make it a watercolor" or "put the cat from the first image on the sofa ' +
              'from the second".',
          },
          image_paths: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: MAX_EDIT_IMAGES,
            description:
              `1 to ${MAX_EDIT_IMAGES} local image files to edit, as absolute paths or paths starting with ~/.`,
          },
          size: {
            type: 'string',
            description: `Output size as ${sizeRule}. Leave it out to follow the input image's aspect ratio.`,
          },
          ...common,
        },
        required: ['prompt', 'image_paths'],
        additionalProperties: false,
      },
      annotations: { title: 'Edit image', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'list_image_models',
      description:
        'List the image models installed on this Mac, for the model argument of generate_image and edit_image.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'List image models', readOnlyHint: true, openWorldHint: false },
    },
  ];
}

/** Check generate_image and edit_image arguments and turn them into engine parameters. */
async function parseImageArgs(args: JsonObject, edit: boolean, defaultModel: string): Promise<GenerateParams> {
  // Some clients send null for arguments they leave out, so null counts as absent throughout. So does
  // a size of "auto", as in OpenAI's API and our HTTP server.
  const { prompt } = args;
  const size = args.size === 'auto' ? undefined : args.size;
  const model = args.model ?? defaultModel;
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required: describe the image.');
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('model must be the name of an installed image model.');
  }
  if (size != null && typeof size !== 'string') throw new Error('size must be a string like "1024x1024".');
  // An edit without a size sends no width or height, so the engine follows the input's aspect ratio.
  const dimensions = size != null ? parseSize(size) : edit ? undefined : parseSize(DEFAULT_SIZE);
  const params: GenerateParams = {
    model: model.trim(),
    prompt,
    ...dimensions,
    steps: optionalInt(args.steps, 'steps', 1, 100),
    seed: optionalInt(args.seed, 'seed', 1, MAX_SEED) ?? randomSeed(),
  };
  if (edit) params.images = await readImages(args.image_paths);
  return params;
}

function optionalInt(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value == null) return undefined;
  // Numbers sent as text are fine. Anything else fails the range check with its usual message.
  return parseIntInRange(typeof value === 'number' || typeof value === 'string' ? value : Number.NaN, name, min, max);
}

/** Read the images to edit as base64. Relative paths are refused: our working directory is the client's. */
async function readImages(value: unknown): Promise<string[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EDIT_IMAGES) {
    throw new Error(`image_paths must be a list of 1 to ${MAX_EDIT_IMAGES} image file paths.`);
  }
  return Promise.all(
    value.map(async (entry: unknown) => {
      const path = typeof entry === 'string' ? expandHome(entry.trim()) : '';
      if (!isAbsolute(path)) {
        throw new Error(`Image paths must be absolute or start with ~/ (got ${JSON.stringify(entry)}).`);
      }
      try {
        return (await readFile(path)).toString('base64');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Image not found: ${path}`);
        throw new Error(`Could not read ${path}: ${(err as Error).message}`);
      }
    }),
  );
}

/** The lines of a text stream, however its chunks happen to split them. */
async function* readLines(input: NodeJS.ReadableStream): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of input) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

/** "~/x" to "/Users/you/x". Paths from MCP configs and agents never pass through a shell that would. */
function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(id: string | number | null, code: number, message: string): object {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
