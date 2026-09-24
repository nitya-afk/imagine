import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runMcpServer, type McpDeps } from '../src/mcp.ts';
import type { GenerateParams } from '../src/ollama.ts';

const PNG = Buffer.from('fake png bytes');

interface Message {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: { path: string; seed: number; model: string };
  isError?: boolean;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, { type: string; description: string; [keyword: string]: unknown }>;
    required?: string[];
    additionalProperties: boolean;
  };
  annotations: { title: string; readOnlyHint: boolean; openWorldHint: boolean };
}

/** A server on in-memory streams, plus the client's side of the conversation. */
function startServer(overrides: Partial<McpDeps> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  // Nested and not there yet, so saving has to create it.
  const outputDir = join(mkdtempSync(join(tmpdir(), 'imagine-mcp-')), 'nested', 'out');
  const calls: GenerateParams[] = [];
  const received: Message[] = [];
  const arrivals = new EventEmitter();

  let partial = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    partial += chunk;
    let newline: number;
    while ((newline = partial.indexOf('\n')) >= 0) {
      received.push(JSON.parse(partial.slice(0, newline)) as Message);
      partial = partial.slice(newline + 1);
      arrivals.emit('message');
    }
  });

  const done = runMcpServer(
    {
      generate: async (params) => {
        calls.push(params);
        return PNG;
      },
      listImageModels: async () => ['x/flux2-klein:latest'],
      defaultModel: 'x/flux2-klein',
      outputDir,
      version: '1.2.3',
      ...overrides,
    },
    input,
    output,
  );

  const waitFor = async (match: (m: Message) => boolean): Promise<Message> => {
    for (;;) {
      const found = received.find(match);
      if (found) return found;
      await once(arrivals, 'message', { signal: AbortSignal.timeout(5000) });
    }
  };
  const send = (message: object) => input.write(`${JSON.stringify(message)}\n`);
  let lastId = 0;
  const request = (method: string, params?: object): Promise<Message> => {
    const id = ++lastId;
    send({ jsonrpc: '2.0', id, method, params });
    return waitFor((m) => m.id === id);
  };

  return {
    input,
    outputDir,
    calls,
    received,
    done,
    send,
    waitFor,
    request,
    async callTool(name: string, args: object, meta?: object): Promise<ToolResult> {
      return (await request('tools/call', { name, arguments: args, _meta: meta })).result as ToolResult;
    },
    /** End the session and wait until everything the server wrote has been read. */
    async close() {
      input.end();
      await done;
      output.end();
      await once(output, 'end');
    },
  };
}

/** A generate() that holds each image until the test releases it. */
function gatedGenerate() {
  const started: GenerateParams[] = [];
  const gates: Array<() => void> = [];
  let running = 0;
  let mostAtOnce = 0;
  return {
    started,
    mostAtOnce: () => mostAtOnce,
    release: () => gates.shift()?.(),
    generate: async (params: GenerateParams) => {
      started.push(params);
      mostAtOnce = Math.max(mostAtOnce, ++running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--;
      return PNG;
    },
  };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the server.');
    await sleep(5);
  }
}

const textOf = (result: ToolResult) => result.content[0]?.text ?? '';
const base64 = (text: string) => Buffer.from(text).toString('base64');

test('initialize agrees on a protocol version and introduces the server', async () => {
  const server = startServer();
  const init = await server.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.1' },
  });
  const result = init.result as {
    protocolVersion: string;
    capabilities: unknown;
    serverInfo: unknown;
    instructions: string;
  };
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.deepEqual(result.serverInfo, { name: 'imagine', version: '1.2.3' });
  assert.ok(result.instructions.includes(server.outputDir), result.instructions);

  const versionFor = async (protocolVersion: unknown) =>
    ((await server.request('initialize', { protocolVersion })).result as { protocolVersion: string }).protocolVersion;
  assert.equal(await versionFor('2024-11-05'), '2024-11-05');
  assert.equal(await versionFor('2025-11-25'), '2025-11-25');
  assert.equal(await versionFor('2099-01-01'), '2025-11-25', 'a version we do not know gets the latest');
  assert.equal(await versionFor(undefined), '2025-11-25');
  await server.close();
});

test('tools/list offers three tools with strict input schemas', async () => {
  const server = startServer();
  const { tools } = (await server.request('tools/list')).result as { tools: Tool[] };
  assert.deepEqual(
    tools.map((t) => t.name),
    ['generate_image', 'edit_image', 'list_image_models'],
  );
  for (const tool of tools) {
    assert.ok(tool.description.length > 40, tool.name);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    for (const [key, schema] of Object.entries(tool.inputSchema.properties)) {
      assert.ok(schema.description, `${tool.name}.${key} has a description`);
    }
    assert.ok(tool.annotations.title);
    assert.equal(tool.annotations.readOnlyHint, tool.name === 'list_image_models');
    assert.equal(tool.annotations.openWorldHint, false);
  }

  const [generate, edit, list] = tools as [Tool, Tool, Tool];
  const g = generate.inputSchema.properties;
  assert.deepEqual(generate.inputSchema.required, ['prompt']);
  assert.deepEqual(Object.keys(g), ['prompt', 'size', 'seed', 'steps', 'model']);
  assert.deepEqual([g.size?.type, g.size?.default], ['string', '1024x1024']);
  assert.deepEqual([g.seed?.type, g.seed?.minimum, g.seed?.maximum], ['integer', 1, 2147483647]);
  assert.deepEqual([g.steps?.type, g.steps?.minimum, g.steps?.maximum], ['integer', 1, 100]);
  assert.equal(g.model?.default, 'x/flux2-klein');

  const e = edit.inputSchema.properties;
  assert.deepEqual(edit.inputSchema.required, ['prompt', 'image_paths']);
  assert.deepEqual(Object.keys(e), ['prompt', 'image_paths', 'size', 'seed', 'steps', 'model']);
  assert.deepEqual([e.image_paths?.type, e.image_paths?.minItems, e.image_paths?.maxItems], ['array', 1, 4]);
  assert.equal(e.size?.default, undefined, 'an edit keeps the input size unless told otherwise');

  assert.deepEqual(list.inputSchema.properties, {});
  await server.close();
});

test('generate_image saves the PNG and returns it with its path and seed', async () => {
  const server = startServer();
  const result = await server.callTool('generate_image', { prompt: 'a red fox', size: '512x768', seed: 42, steps: 4 });
  assert.equal(result.isError, undefined);

  const path = /^Saved to (.+) \(seed 42, 512x768\)$/.exec(textOf(result))?.[1];
  assert.ok(path, textOf(result));
  assert.ok(isAbsolute(path) && path.startsWith(server.outputDir), path);
  assert.match(path, /\/\d{8}-\d{6}-a-red-fox-42\.png$/);
  assert.deepEqual(readFileSync(path), PNG);
  assert.deepEqual(result.content[1], { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
  assert.deepEqual(result.structuredContent, { path, seed: 42, model: 'x/flux2-klein' });
  assert.deepEqual(server.calls, [
    { model: 'x/flux2-klein', prompt: 'a red fox', width: 512, height: 768, steps: 4, seed: 42 },
  ]);
  await server.close();
});

test('generate_image defaults to a square image, a random seed and the default model', async () => {
  const server = startServer();
  // Some clients send null for the arguments they leave out.
  const result = await server.callTool('generate_image', {
    prompt: 'a lighthouse',
    size: null,
    seed: null,
    steps: null,
    model: null,
  });
  const params = server.calls[0]!;
  assert.deepEqual(
    [params.model, params.width, params.height, params.steps],
    ['x/flux2-klein', 1024, 1024, undefined],
  );
  assert.ok(Number.isInteger(params.seed) && params.seed >= 1 && params.seed <= 2147483647, String(params.seed));
  assert.equal(result.structuredContent?.seed, params.seed);
  assert.ok(textOf(result).endsWith(`(seed ${params.seed}, 1024x1024)`), textOf(result));

  // "auto" means the default size, and a seed sent as text still counts.
  await server.callTool('generate_image', { prompt: 'a lighthouse', size: 'auto', model: 'x/z-image-turbo', seed: '7' });
  const second = server.calls[1]!;
  assert.deepEqual([second.model, second.width, second.height, second.seed], ['x/z-image-turbo', 1024, 1024, 7]);
  await server.close();
});

test('edit_image sends the input files as base64 and keeps their shape unless given a size', async () => {
  const server = startServer();
  const dir = mkdtempSync(join(tmpdir(), 'imagine-mcp-in-'));
  const first = join(dir, 'first.png');
  const second = join(dir, 'second.jpg');
  writeFileSync(first, 'first image');
  writeFileSync(second, 'second image');

  const result = await server.callTool('edit_image', {
    prompt: 'make it night',
    image_paths: [first, second],
    seed: 9,
  });
  assert.equal(result.isError, undefined);
  assert.match(textOf(result), /-make-it-night-9\.png \(seed 9, input size\)$/);
  const params = server.calls[0]!;
  assert.deepEqual(params.images, [base64('first image'), base64('second image')]);
  assert.ok(!('width' in params) && !('height' in params), 'no size means no width or height');

  await server.callTool('edit_image', { prompt: 'widen it', image_paths: [first], size: '768x512' });
  assert.deepEqual([server.calls[1]?.width, server.calls[1]?.height], [768, 512]);
  await server.close();
});

test('edit_image expands ~/ to the home folder', async () => {
  const home = mkdtempSync(join(tmpdir(), 'imagine-home-'));
  writeFileSync(join(home, 'cat.png'), 'a cat');
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const server = startServer();
    const result = await server.callTool('edit_image', { prompt: 'add a hat', image_paths: ['~/cat.png'] });
    assert.equal(result.isError, undefined, textOf(result));
    assert.deepEqual(server.calls[0]?.images, [base64('a cat')]);
    await server.close();
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
  }
});

test('edit_image reports a missing file as a tool error', async () => {
  const server = startServer();
  const missing = join(mkdtempSync(join(tmpdir(), 'imagine-mcp-in-')), 'missing.png');
  const result = await server.callTool('edit_image', { prompt: 'make it night', image_paths: [missing] });
  assert.deepEqual(result, { content: [{ type: 'text', text: `Image not found: ${missing}` }], isError: true });
  assert.equal(server.calls.length, 0);
  await server.close();
});

test('invalid arguments come back as tool errors the caller can correct', async () => {
  const server = startServer();
  const cases: Array<[string, object, RegExp]> = [
    ['generate_image', {}, /prompt is required/],
    ['generate_image', { prompt: '   ' }, /prompt is required/],
    ['generate_image', { prompt: 'x', size: '1000x1000' }, /multiple of 16/],
    ['generate_image', { prompt: 'x', size: 1024 }, /size must be a string/],
    ['generate_image', { prompt: 'x', seed: 0 }, /seed must be a whole number from 1 to 2147483647/],
    ['generate_image', { prompt: 'x', steps: 2.5 }, /steps must be a whole number from 1 to 100/],
    ['generate_image', { prompt: 'x', model: '' }, /model must be/],
    ['generate_image', { prompt: 'x', negative_prompt: 'blur' }, /Unknown argument "negative_prompt"/],
    ['edit_image', { prompt: 'x' }, /image_paths must be a list of 1 to 4/],
    ['edit_image', { prompt: 'x', image_paths: ['/a', '/b', '/c', '/d', '/e'] }, /1 to 4/],
    ['edit_image', { prompt: 'x', image_paths: ['cat.png'] }, /absolute/],
  ];
  for (const [name, args, expected] of cases) {
    const result = await server.callTool(name, args);
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    assert.match(textOf(result), expected);
  }
  assert.equal(server.calls.length, 0, 'nothing reached the engine');
  await server.close();
});

test('engine failures are tool errors and do not hold up later requests', async () => {
  const server = startServer({
    generate: async (params) => {
      if (params.model === 'x/missing') throw new Error('model "x/missing" not found');
      return PNG;
    },
  });
  const failed = await server.callTool('generate_image', { prompt: 'x', model: 'x/missing' });
  assert.deepEqual(failed, { content: [{ type: 'text', text: 'model "x/missing" not found' }], isError: true });
  assert.equal((await server.callTool('generate_image', { prompt: 'x' })).isError, undefined);
  await server.close();
});

test('list_image_models lists the installed models, or says how to get one', async () => {
  let installed = ['x/flux2-klein:latest', 'x/z-image-turbo:latest'];
  const server = startServer({ listImageModels: async () => installed });
  const listed = (await server.request('tools/call', { name: 'list_image_models' })).result as ToolResult;
  assert.equal(listed.isError, undefined);
  assert.match(textOf(listed), /^- x\/flux2-klein:latest$/m);
  assert.match(textOf(listed), /^- x\/z-image-turbo:latest$/m);

  installed = [];
  assert.match(textOf(await server.callTool('list_image_models', {})), /imagine pull x\/flux2-klein/);
  await server.close();
});

test('unknown methods and tools are JSON-RPC errors', async () => {
  const server = startServer();
  assert.equal((await server.request('resources/list')).error?.code, -32601);
  const unknownTool = await server.request('tools/call', { name: 'make_video', arguments: {} });
  assert.equal(unknownTool.error?.code, -32602);
  assert.match(unknownTool.error?.message ?? '', /make_video/);
  await server.close();
});

test('generation steps are sent as progress notifications when the client asks', async () => {
  const server = startServer({
    generate: async (_params, onProgress) => {
      for (const completed of [0, 1, 1, 2]) onProgress?.({ completed, total: 2 });
      return PNG;
    },
  });
  const progress = () => server.received.filter((m) => m.method === 'notifications/progress');

  await server.callTool('generate_image', { prompt: 'x' });
  assert.equal(progress().length, 0, 'no token, no progress');

  await server.callTool('generate_image', { prompt: 'x' }, { progressToken: 'gen-1' });
  // The repeated step is dropped: MCP progress has to go up with every notification.
  assert.deepEqual(
    progress().map((m) => m.params),
    [
      { progressToken: 'gen-1', progress: 0, total: 2, message: 'Generating' },
      { progressToken: 'gen-1', progress: 1, total: 2, message: 'Generating' },
      { progressToken: 'gen-1', progress: 2, total: 2, message: 'Generating' },
    ],
  );
  const reply = server.received.findIndex((m) => m.id === 2);
  assert.ok(server.received.indexOf(progress().at(-1)!) < reply, 'progress comes before the result');
  await server.close();
});

test('answers requests while an image is generating, and generates one image at a time', async () => {
  const gate = gatedGenerate();
  const server = startServer({ generate: gate.generate });
  const first = server.callTool('generate_image', { prompt: 'first' });
  const second = server.callTool('generate_image', { prompt: 'second' });
  await until(() => gate.started.length === 1);

  assert.deepEqual((await server.request('ping')).result, {});
  assert.equal(((await server.request('tools/list')).result as { tools: Tool[] }).tools.length, 3);
  assert.equal(gate.started.length, 1, 'the second image waits for the first');

  gate.release();
  assert.match(textOf(await first), /-first-/);
  await until(() => gate.started.length === 2);
  gate.release();
  assert.match(textOf(await second), /-second-/);
  assert.equal(gate.mostAtOnce(), 1);
  await server.close();
});

test('notifications and stray responses get no reply', async () => {
  const server = startServer();
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  server.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1, reason: 'user' } });
  server.send({ jsonrpc: '2.0', method: 'tools/list' }); // no id makes it a notification, whatever the method
  server.send({ jsonrpc: '2.0', id: 99, result: {} }); // a response to a request the server never made
  await server.close();
  assert.deepEqual(server.received, []);
});

test('malformed messages get JSON-RPC errors and the session carries on', async () => {
  const server = startServer();
  server.input.write('{"jsonrpc": "2.0", "id": 1, "method": \n');
  assert.equal((await server.waitFor((m) => m.error?.code === -32700)).id, null);

  server.input.write('[]\n');
  assert.equal((await server.waitFor((m) => m.error?.code === -32600)).id, null);
  server.send({ jsonrpc: '2.0', id: 'no-method' });
  assert.equal((await server.waitFor((m) => m.id === 'no-method')).error?.code, -32600);

  assert.deepEqual((await server.request('ping')).result, {});
  await server.close();
});

test('messages split across chunks, or sharing one, arrive intact', async () => {
  const server = startServer();
  const call = { name: 'generate_image', arguments: { prompt: 'café ☕ at dawn' } };
  const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: call })}\n`);
  const cut = bytes.indexOf('☕') + 1; // inside the three bytes of ☕
  server.input.write(bytes.subarray(0, cut));
  await sleep(5);
  const ping = Buffer.from('{"jsonrpc": "2.0", "id": "b", "method": "ping"}\r\n');
  server.input.write(Buffer.concat([bytes.subarray(cut), ping]));

  assert.equal(((await server.waitFor((m) => m.id === 'a')).result as ToolResult).isError, undefined);
  assert.deepEqual((await server.waitFor((m) => m.id === 'b')).result, {});
  assert.equal(server.calls[0]?.prompt, 'café ☕ at dawn');
  await server.close();
});

test('runMcpServer resolves only after input ends and in-flight requests are answered', async () => {
  const gate = gatedGenerate();
  const server = startServer({ generate: gate.generate });
  const reply = server.callTool('generate_image', { prompt: 'the last one' });
  await until(() => gate.started.length === 1);

  server.input.end();
  let finished = false;
  void server.done.then(() => {
    finished = true;
  });
  await sleep(20);
  assert.equal(finished, false, 'still generating');

  gate.release();
  await server.done;
  assert.equal((await reply).isError, undefined);
});

test('a large last reply reaches a real pipe in full, even when the process exits right after', async () => {
  // The CLI exits as soon as runMcpServer resolves, and pipe writes on macOS finish asynchronously.
  const script = `
    import { runMcpServer } from ${JSON.stringify(new URL('../src/mcp.ts', import.meta.url).href)};
    await runMcpServer({
      generate: async () => Buffer.alloc(3_000_000, 7),
      listImageModels: async () => [],
      defaultModel: 'x/flux2-klein',
      outputDir: ${JSON.stringify(mkdtempSync(join(tmpdir(), 'imagine-mcp-pipe-')))},
      version: '1.2.3',
    });
    process.exit(0);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  const call = { name: 'generate_image', arguments: { prompt: 'a big one' } };
  child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: call })}\n`);
  await once(child, 'close');

  const reply = JSON.parse(stdout) as Message;
  const image = (reply.result as ToolResult).content[1];
  assert.equal(image?.data, Buffer.alloc(3_000_000, 7).toString('base64'));
});
