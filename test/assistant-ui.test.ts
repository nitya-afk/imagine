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
    const memories = await (await api('/api/assistant/memory')).json();
    assert.equal(memories.memories[0].text, 'My preferred tone is concise');
    const chat = await api('/api/assistant/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'Hello' }) });
    assert.equal(chat.status, 200);
    const events = (await chat.text()).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ['status', 'answer', 'done']);
    assert.equal(events[1].content, 'A local reply.');
    const removed = await (await api(`/api/assistant/memory/${saved.id}`, { method: 'DELETE' })).json();
    assert.equal(removed.deleted, true);
    assert.deepEqual(memory.list(), []);
  } finally { server.close(); }
});
