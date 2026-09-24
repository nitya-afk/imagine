import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { GenerateParams } from '../src/ollama.ts';
import { createImageServer, parseGenerationRequest } from '../src/server.ts';

const PNG = Buffer.from('fake png bytes');
const outputDir = mkdtempSync(join(tmpdir(), 'imagine-serve-'));
const calls: GenerateParams[] = [];
let server: Server;
let base: string;

function start(apiKey?: string): Promise<{ server: Server; base: string }> {
  const s = createImageServer({
    defaultModel: 'x/flux2-klein',
    outputDir,
    apiKey,
    generate: async (params) => {
      calls.push(params);
      return PNG;
    },
    listImageModels: async () => ['x/flux2-klein'],
  });
  return new Promise((resolve) =>
    s.listen(0, '127.0.0.1', () => resolve({ server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` })),
  );
}

before(async () => {
  ({ server, base } = await start());
});
after(() => server.close());

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('generates images in the OpenAI response shape', async () => {
  calls.length = 0;
  const res = await post(`${base}/v1/images/generations`, { prompt: 'a lighthouse', n: 2, size: '512x768', seed: 7 });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { created: number; data: Array<{ b64_json: string }> };
  assert.equal(typeof body.created, 'number');
  assert.equal(body.data.length, 2);
  assert.deepEqual(Buffer.from(body.data[0]!.b64_json, 'base64'), PNG);
  assert.deepEqual(
    calls.map((c) => [c.model, c.width, c.height, c.seed]),
    [
      ['x/flux2-klein', 512, 768, 7],
      ['x/flux2-klein', 512, 768, 8],
    ],
  );
});

test('response_format "url" saves the image and serves it back', async () => {
  const res = await post(`${base}/v1/images/generations`, { prompt: 'a fox', response_format: 'url' });
  const body = (await res.json()) as { data: Array<{ url: string }> };
  const url = body.data[0]!.url;
  assert.match(url, /\/images\/\d{8}-\d{6}-a-fox-\d+\.png$/);
  const image = await fetch(url);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);
  assert.deepEqual(readFileSync(join(outputDir, decodeURIComponent(url.split('/images/')[1]!))), PNG);
});

test('image route cannot read outside the output folder', async () => {
  const res = await fetch(`${base}/images/..%2F..%2Fetc%2Fpasswd`);
  assert.equal(res.status, 404);
});

test('invalid requests get OpenAI-style 400 errors', async () => {
  const res = await post(`${base}/v1/images/generations`, { size: '1024x1024' });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: { message: string; type: string } };
  assert.equal(body.error.type, 'invalid_request_error');
  assert.match(body.error.message, /prompt/);
});

test('lists image models', async () => {
  const body = (await (await fetch(`${base}/v1/models`)).json()) as { data: Array<{ id: string }> };
  assert.deepEqual(body.data.map((m) => m.id), ['x/flux2-klein']);
});

test('an API key, when set, is required', async () => {
  const guarded = await start('secret');
  try {
    const url = `${guarded.base}/v1/images/generations`;
    assert.equal((await post(url, { prompt: 'x' })).status, 401);
    assert.equal((await post(url, { prompt: 'x' }, { authorization: 'Bearer wrong!' })).status, 401);
    assert.equal((await post(url, { prompt: 'x' }, { authorization: 'Bearer secret' })).status, 200);
  } finally {
    guarded.server.close();
  }
});

test('parseGenerationRequest maps OpenAI model names to the local default', () => {
  assert.equal(parseGenerationRequest({ prompt: 'x', model: 'dall-e-3' }, 'local').model, 'local');
  assert.equal(parseGenerationRequest({ prompt: 'x', model: 'gpt-image-1' }, 'local').model, 'local');
  assert.equal(parseGenerationRequest({ prompt: 'x', model: 'x/z-image-turbo' }, 'local').model, 'x/z-image-turbo');
  const req = parseGenerationRequest({ prompt: 'x', size: 'auto', quality: 'hd', style: 'vivid' }, 'local');
  assert.deepEqual([req.width, req.height, req.n, req.responseFormat], [1024, 1024, 1, 'b64_json']);
  assert.throws(() => parseGenerationRequest({ prompt: 'x', n: 10 }, 'local'), /`n`/);
  assert.throws(() => parseGenerationRequest({ prompt: 'x', response_format: 'png' }, 'local'), /response_format/);
});

const edit = (form: FormData) => fetch(`${base}/v1/images/edits`, { method: 'POST', body: form });

function editForm(fields: Record<string, string>, images: Array<[string, Buffer]> = [['image', Buffer.from('cat png')]]) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const [field, bytes] of images) form.append(field, new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'in.png');
  return form;
}

test('edits take multipart images and keep the input shape when no size is given', async () => {
  calls.length = 0;
  const res = await edit(editForm({ prompt: 'make it night', model: 'gpt-image-1', seed: '5' }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: Array<{ b64_json: string }> };
  assert.deepEqual(Buffer.from(body.data[0]!.b64_json, 'base64'), PNG);
  const call = calls[0]!;
  assert.deepEqual(call.images, [Buffer.from('cat png').toString('base64')]);
  assert.equal(call.width, undefined);
  assert.equal(call.height, undefined);
  assert.equal(call.seed, 5);
  assert.equal(call.model, 'x/flux2-klein');
});

test('edits accept image[] for several references and an explicit size', async () => {
  calls.length = 0;
  const form = editForm({ prompt: 'combine', size: '768x512', n: '1' }, [
    ['image[]', Buffer.from('a')],
    ['image[]', Buffer.from('b')],
  ]);
  assert.equal((await edit(form)).status, 200);
  assert.equal(calls[0]!.images?.length, 2);
  assert.deepEqual([calls[0]!.width, calls[0]!.height], [768, 512]);
});

test('edit requests without an image, with a mask, or as JSON are rejected clearly', async () => {
  const noImage = await edit(editForm({ prompt: 'x' }, []));
  assert.equal(noImage.status, 400);
  assert.match(((await noImage.json()) as { error: { message: string } }).error.message, /image/);

  const withMask = editForm({ prompt: 'x' });
  withMask.append('mask', new Blob([new Uint8Array([1])]), 'mask.png');
  const mask = await edit(withMask);
  assert.equal(mask.status, 400);
  assert.match(((await mask.json()) as { error: { message: string } }).error.message, /Masks/);

  const json = await post(`${base}/v1/images/edits`, { prompt: 'x' });
  assert.equal(json.status, 400);
});
