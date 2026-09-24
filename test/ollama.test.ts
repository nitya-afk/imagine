import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { generateImage, isImageGenUnsupported, OllamaError } from '../src/ollama.ts';

const PNG = Buffer.from('fake png bytes');
let server: Server;
let host: string;
let lastBody: Record<string, unknown> = {};

// A stand-in for Ollama's /api/generate, streaming the same message shapes 0.32.5 sends.
before(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    lastBody = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;

    if (lastBody.model === 'removed') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'image generation models are not currently supported' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    if (lastBody.model === 'crashes') {
      res.end(`${JSON.stringify({ error: 'runner crashed' })}\n`);
      return;
    }
    if (lastBody.model === 'too-big') {
      res.end(`${JSON.stringify({ done: true, response: 'error: insufficient memory for image generation' })}\n`);
      return;
    }
    res.write(`${JSON.stringify({ done: false, total: 2 })}\n`);
    res.write(`${JSON.stringify({ done: false, completed: 1, total: 2 })}\n`);
    res.write(`${JSON.stringify({ done: false, completed: 2, total: 2 })}\n`);
    // Split the final line across writes, as happens with multi-megabyte images.
    const last = JSON.stringify({ done: true, done_reason: 'stop', image: PNG.toString('base64') });
    res.write(last.slice(0, 10));
    res.end(`${last.slice(10)}\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

test('streams progress and returns the decoded image', async () => {
  const progress: string[] = [];
  const png = await generateImage(
    host,
    { model: 'x/flux2-klein', prompt: 'apple', width: 512, height: 768, steps: 4, seed: 42 },
    (p) => progress.push(`${p.completed}/${p.total}`),
  );
  assert.deepEqual(png, PNG);
  assert.deepEqual(progress, ['0/2', '1/2', '2/2']);
  assert.equal(lastBody.width, 512);
  assert.equal(lastBody.height, 768);
  assert.equal(lastBody.steps, 4);
  assert.deepEqual(lastBody.options, { seed: 42 });
});

test('recognises an Ollama build without image generation', async () => {
  const err = await generateImage(host, { model: 'removed', prompt: 'x', seed: 1 }).catch((e: unknown) => e);
  assert.ok(err instanceof OllamaError);
  assert.equal(err.status, 400);
  assert.ok(isImageGenUnsupported(err));
});

test('surfaces errors sent mid-stream', async () => {
  await assert.rejects(generateImage(host, { model: 'crashes', prompt: 'x', seed: 1 }), /runner crashed/);
});

test('surfaces image-runner failures reported as a final "error:" message', async () => {
  await assert.rejects(
    generateImage(host, { model: 'too-big', prompt: 'x', seed: 1 }),
    /^OllamaError: insufficient memory for image generation$/,
  );
});
