import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import type { GenerateParams } from '../src/ollama.ts';
import { crc32, withMetadata } from '../src/png.ts';
import { createUiServer } from '../src/ui.ts';

/** A real, minimal RGB PNG. */
function tinyPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outputDir = mkdtempSync(join(tmpdir(), 'imagine-ui-'));
const calls: GenerateParams[] = [];
let server: Server;
let token: string;
let base: string;

before(async () => {
  ({ server, token } = createUiServer({
    version: '9.9.9',
    outputDir,
    defaultModel: 'x/flux2-klein',
    listImageModels: async () => ['x/flux2-klein:latest', 'klein-4b-mxfp8:latest'],
    enhance: async (idea, onStatus) => {
      onStatus('Writing the prompt…');
      return `${idea}, golden hour, 35mm film`;
    },
    generate: async (params, onProgress, idea) => {
      calls.push(params);
      onProgress?.({ completed: 1, total: 2 });
      onProgress?.({ completed: 2, total: 2 });
      // Like the engine: an edit keeps the input's size unless it's told otherwise.
      const input = params.images?.[0] ? Buffer.from(params.images[0], 'base64') : null;
      const width = params.width ?? input?.readUInt32BE(16) ?? 64;
      const height = params.height ?? input?.readUInt32BE(20) ?? 64;
      return withMetadata(tinyPng(width, height), {
        prompt: params.prompt,
        idea,
        model: params.model,
        seed: params.seed,
        width,
        height,
        edit: Boolean(params.images?.length),
        generator: 'imagine test',
      });
    },
  }));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...(init.headers as object), 'x-imagine-token': token } });

async function events(res: Response): Promise<Array<Record<string, any>>> {
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/x-ndjson');
  return (await res.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('serves the page with this session token, version and model baked in', async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes(`const TOKEN = '${token}'`));
  assert.ok(html.includes('v9.9.9'));
  assert.ok(html.includes(`const DEFAULT_MODEL = 'x/flux2-klein'`));
  assert.ok(!html.includes('__IMAGINE_'));
});

test('the API refuses calls without the session token', async () => {
  for (const path of ['/api/models', '/api/gallery']) {
    assert.equal((await fetch(`${base}${path}`)).status, 401);
    assert.equal((await fetch(`${base}${path}`, { headers: { 'x-imagine-token': 'x'.repeat(32) } })).status, 401);
  }
  const res = await fetch(`${base}/api/generate`, { method: 'POST', body: '{"prompt":"a cat"}' });
  assert.equal(res.status, 401);
});

test('a page reached through another host name (DNS rebinding) is refused', async () => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${base}/`, { headers: { host: 'evil.example:11437' } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('lists the image models', async () => {
  const body = await (await api('/api/models')).json();
  assert.deepEqual(body, { models: ['x/flux2-klein:latest', 'klein-4b-mxfp8:latest'], defaultModel: 'x/flux2-klein' });
});

test('generate streams progress, then each saved image with its settings', async () => {
  calls.length = 0;
  const res = await api('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'a lighthouse', size: '832x1216', count: 2, seed: 7, model: 'klein-4b-mxfp8' }),
  });
  const all = await events(res);
  assert.deepEqual(
    calls.map((c) => [c.model, c.prompt, c.width, c.height, c.seed]),
    [
      ['klein-4b-mxfp8', 'a lighthouse', 832, 1216, 7],
      ['klein-4b-mxfp8', 'a lighthouse', 832, 1216, 8],
    ],
  );
  assert.ok(all.some((e) => e.type === 'progress' && e.completed === 2 && e.total === 2));
  const images = all.filter((e) => e.type === 'image').map((e) => e.image);
  assert.equal(images.length, 2);
  assert.equal(images[0].seed, 7);
  assert.equal(images[0].width, 832);
  assert.equal(images[0].prompt, 'a lighthouse');
  assert.equal(all.at(-1)!.type, 'done');

  const png = await api(images[0].url);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.ok(existsSync(join(outputDir, images[0].name)));
});

test('enhance sends the written prompt and keeps the original idea', async () => {
  calls.length = 0;
  const res = await api('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'a fox', enhance: true }),
  });
  const all = await events(res);
  assert.deepEqual(
    all.find((e) => e.type === 'prompt'),
    { type: 'prompt', prompt: 'a fox, golden hour, 35mm film' },
  );
  assert.equal(calls[0]!.prompt, 'a fox, golden hour, 35mm film');
  const image = all.find((e) => e.type === 'image')!.image;
  assert.equal(image.idea, 'a fox');
});

test('generate rejects an empty prompt and a bad size before starting', async () => {
  const empty = await api('/api/generate', { method: 'POST', body: JSON.stringify({ prompt: '  ' }) });
  assert.equal(empty.status, 400);
  const size = await api('/api/generate', { method: 'POST', body: JSON.stringify({ prompt: 'a', size: 'huge' }) });
  assert.equal(size.status, 400);
});

test('edit takes an uploaded photo, runs the steps and streams each one', async () => {
  calls.length = 0;
  const form = new FormData();
  form.append('photo', new Blob([new Uint8Array(tinyPng(800, 600))], { type: 'image/png' }), 'photo.png');
  form.append('background', 'a beach at sunset');
  form.append('extend', '16:9');
  form.append('seed', '5');
  form.append('check', 'false');
  const all = await events(await api('/api/edit', { method: 'POST', body: form }));

  assert.deepEqual(all.find((e) => e.type === 'plan')!.steps.length, 2);
  const steps = all.filter((e) => e.type === 'step');
  assert.deepEqual(
    steps.map((s) => [s.index, s.total]),
    [
      [0, 2],
      [1, 2],
    ],
  );
  assert.ok(steps[0]!.preview.startsWith('data:image/png;base64,'));
  // Each step edits the result of the one before; the extend step widens the frame.
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.images?.length === 1));
  assert.equal(calls[0]!.width, undefined);
  assert.deepEqual([calls[1]!.width, calls[1]!.height], [1072, 608]);
  const image = all.find((e) => e.type === 'image')!.image;
  assert.equal(image.edit, true);
  assert.equal(all.at(-1)!.type, 'done');
});

test('edit can continue from a picture in the gallery, and nothing outside it', async () => {
  const gallery = (await (await api('/api/gallery')).json()).images as Array<{ name: string }>;
  assert.ok(gallery.length >= 3);
  const form = new FormData();
  form.append('from', gallery[0]!.name);
  form.append('style', 'watercolor');
  const all = await events(await api('/api/edit', { method: 'POST', body: form }));
  assert.equal(all.at(-1)!.type, 'done');

  const escape = new FormData();
  escape.append('from', '../../etc/passwd');
  escape.append('style', 'watercolor');
  assert.equal((await api('/api/edit', { method: 'POST', body: escape })).status, 404);
  assert.equal((await api('/images/..%2F..%2Fetc%2Fpasswd')).status, 404);
});

test('edit with nothing to change reports it in the stream', async () => {
  const form = new FormData();
  form.append('photo', new Blob([new Uint8Array(tinyPng(64, 64))], { type: 'image/png' }), 'photo.png');
  const all = await events(await api('/api/edit', { method: 'POST', body: form }));
  assert.equal(all.at(-1)!.type, 'error');
  assert.match(all.at(-1)!.message, /Say what to change/);
});

test('the gallery lists the newest images first, with their settings', async () => {
  const { images } = (await (await api('/api/gallery')).json()) as { images: Array<Record<string, unknown>> };
  assert.ok(images.length >= 4);
  assert.equal(images[0]!.edit, true);
  assert.ok(images.every((i) => typeof i.url === 'string' && String(i.url).startsWith('/images/')));
});

test('jobs run one at a time', async () => {
  let running = 0;
  let most = 0;
  const { server: s, token: t } = createUiServer({
    version: '1',
    outputDir: mkdtempSync(join(tmpdir(), 'imagine-ui-queue-')),
    defaultModel: 'm',
    listImageModels: async () => [],
    generate: async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return tinyPng(8, 8);
    },
  });
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/generate`;
  const go = () =>
    fetch(url, { method: 'POST', headers: { 'x-imagine-token': t }, body: JSON.stringify({ prompt: 'x' }) }).then((r) =>
      r.text(),
    );
  const bodies = await Promise.all([go(), go(), go()]);
  s.close();
  assert.equal(most, 1);
  assert.ok(bodies.some((b) => b.includes('Waiting')));
});
