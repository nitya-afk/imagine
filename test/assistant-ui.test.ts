import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from '../src/assistant.ts';
import { createUiServer } from '../src/ui.ts';

test('assistant UI routes keep the session token and stream answers', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'imagine-assistant-ui-'));
  const memory = new MemoryStore(join(folder, 'memory.json'));
  const saved = memory.add('My preferred tone is concise');
  const { server, token } = createUiServer({
    version: 'test', outputDir: folder, defaultModel: 'test-image',
    generate: async () => Buffer.alloc(0), listImageModels: async () => [],
    assistantMemory: memory,
    assistantModels: async () => ({ models: [{ name: 'qwen3.5:4b', size: 3.4e9 }], defaultModel: 'qwen3.5:4b', recommended: 'qwen3.5:4b', highQuality: 'qwen3.5:9b', memoryBytes: 8e9, projectDir: folder }),
    assistant: () => ({ run: async (_prompt, _history, emit) => { emit?.({ type: 'status', message: 'Thinking locally…' }); return 'A local reply.'; } }),
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.headers as object), 'x-imagine-token': token } });
  try {
    assert.equal((await fetch(base + '/api/assistant/models')).status, 401);
    const models = await (await api('/api/assistant/models')).json();
    assert.equal(models.defaultModel, 'qwen3.5:4b');
    const router = await (await api('/api/assistant/router')).json();
    assert.equal(router.configured, false);
    const html = await (await fetch(base)).text();
    assert.match(html, /id="guide-modal"/);
    assert.match(html, /id="assistant-mode"/);
    const memories = await (await api('/api/assistant/memory')).json();
    assert.equal(memories.memories[0].text, 'My preferred tone is concise');
    const chat = await api('/api/assistant/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Hello' }) });
    assert.equal(chat.status, 200);
    const events = (await chat.text()).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ['route', 'status', 'answer', 'done']);
    assert.equal(events[2].content, 'A local reply.');
    const removed = await (await api(`/api/assistant/memory/${saved.id}`, { method: 'DELETE' })).json();
    assert.equal(removed.deleted, true);
    assert.deepEqual(memory.list(), []);
  } finally { server.close(); }
});

test('frontier routing requires per-request approval and never exposes the API key', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'imagine-frontier-ui-'));
  const calls: Array<{ url: string; body: Record<string, any> }> = [];
  const frontierFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (String(url).endsWith('/input_tokens')) return new Response(JSON.stringify({ input_tokens: 100 }));
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Cloud answer.' }] }], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } }));
  }) as typeof fetch;
  const { server, token } = createUiServer({
    version: 'test', outputDir: folder, defaultModel: 'test-image', generate: async () => Buffer.alloc(0), listImageModels: async () => [],
    frontierKey: 'secret-test-key', frontierFetch,
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.headers as object), 'x-imagine-token': token } });
  try {
    const status = await (await api('/api/assistant/router')).text();
    assert.match(status, /"configured":true/);
    assert.ok(!status.includes('secret-test-key'));
    const res = await api('/api/assistant/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Hello', history: [{ role: 'user', content: 'private prior chat' }], mode: 'frontier', frontierTier: 'fast' }), signal: AbortSignal.timeout(5000) });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let data = '';
    let approval: { id: string } | undefined;
    while (!approval) {
      const next = await reader.read();
      if (next.done) throw new Error('Stream ended before approval.');
      data += decoder.decode(next.value);
      approval = data.split('\n').filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.type === 'approval');
    }
    assert.equal(calls.length, 0);
    await api('/api/assistant/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: approval.id, allow: true }) });
    for (;;) { const next = await reader.read(); if (next.done) break; data += decoder.decode(next.value); }
    const events = data.trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === 'answer' && event.content === 'Cloud answer.'));
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => !JSON.stringify(call.body).includes('private prior chat')));
    assert.deepEqual(calls[1]?.body.input, [{ role: 'user', content: 'Hello' }]);
  } finally { server.close(); }
});

test('disconnecting cancels a local run and lets the next queued chat finish', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'imagine-cancel-ui-'));
  let cancelled!: () => void;
  const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
  const { server, token } = createUiServer({
    version: 'test', outputDir: folder, defaultModel: 'image', generate: async () => Buffer.alloc(0), listImageModels: async () => [],
    assistant: ({ signal }) => ({ run: async (prompt, _history, emit) => {
      if (prompt !== 'Cancel this') return 'Next run completed.';
      emit?.({ type: 'status', message: 'Started' });
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => { cancelled(); reject(new Error('Aborted')); }, { once: true });
      });
    } }),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const chat = (prompt: string, signal?: AbortSignal) => fetch(base + '/api/assistant/chat', { method: 'POST', headers: { 'x-imagine-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ prompt }), signal });
  try {
    const controller = new AbortController();
    const response = await chat('Cancel this', controller.signal);
    const reader = response.body!.getReader(); await reader.read();
    controller.abort();
    await Promise.race([cancellation, new Promise<never>((_resolve, reject) => { setTimeout(() => reject(new Error('Run did not cancel')), 2000).unref(); })]);
    const next = await chat('Next', AbortSignal.timeout(2000));
    assert.match(await next.text(), /Next run completed/);
  } finally { server.close(); }
});

test('disconnecting while waiting for cloud approval clears it and sends no cloud request', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'imagine-cancel-approval-'));
  let requests = 0;
  const { server, token } = createUiServer({
    version: 'test', outputDir: folder, defaultModel: 'image', generate: async () => Buffer.alloc(0), listImageModels: async () => [], frontierKey: 'test-key',
    frontierFetch: (async () => { requests++; throw new Error('Must not send'); }) as typeof fetch,
    assistant: () => ({ run: async () => 'Queue is free.' }),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, init: RequestInit) => fetch(base + path, { ...init, headers: { 'x-imagine-token': token, 'content-type': 'application/json' } });
  try {
    const controller = new AbortController();
    const response = await api('/api/assistant/chat', { method: 'POST', body: JSON.stringify({ prompt: 'Hello', mode: 'frontier' }), signal: controller.signal });
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let approval: { id: string } | undefined, buffer = '';
    while (!approval) { const next = await reader.read(); if (next.done) throw new Error('No approval'); buffer += decoder.decode(next.value); approval = buffer.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.type === 'approval'); }
    controller.abort();
    const next = await api('/api/assistant/chat', { method: 'POST', body: JSON.stringify({ prompt: 'Next' }), signal: AbortSignal.timeout(2000) });
    assert.match(await next.text(), /Queue is free/);
    const late = await api('/api/assistant/approve', { method: 'POST', body: JSON.stringify({ id: approval.id, allow: true }) });
    assert.equal(late.status, 404); assert.equal(requests, 0);
  } finally { server.close(); }
});
