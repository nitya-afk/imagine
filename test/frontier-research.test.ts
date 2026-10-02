import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RunStore } from '../src/runs.ts';
import { createUiServer } from '../src/ui.ts';

test('frontier gets public retrieval evidence only after approval; web off performs no retrieval', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'imagine-cloud-research-'));
  const calls: Array<Record<string, any>> = []; let searches = 0, reads = 0;
  const { server, token } = createUiServer({
    version: 'test', outputDir: folder, defaultModel: 'image', assistantRuns: new RunStore(join(folder, 'runs')), generate: async () => Buffer.alloc(0), listImageModels: async () => [], frontierKey: 'test-secret',
    researchFetch: (async () => { searches++; return new Response('<div data-type="web"><a href="https://example.com/person"><div class="search-snippet-title">Public person</div></a><div class="generic-snippet">A public profile.</div></div>'); }) as typeof fetch,
    webReader: async url => { reads++; return { url, title: 'Public profile', text: 'A public professional profile.', links: [], truncated: false, format: 'html' }; },
    frontierFetch: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return String(url).endsWith('input_tokens') ? Response.json({ input_tokens: 500 }) : Response.json({ status: 'completed', usage: { total_tokens: 550 }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'A professional. [Source](https://example.com/person)' }] }] });
    }) as typeof fetch,
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = (path: string, body: object) => fetch(base + path, { method: 'POST', headers: { 'x-imagine-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
  const chat = async (web: boolean) => {
    const res = await api('/api/assistant/chat', { prompt: 'who is Public Person', mode: 'frontier', web, history: [{ role: 'user', content: 'private history' }] });
    const reader = res.body!.getReader(), decoder = new TextDecoder();
    let buffer = ''; const events: Array<Record<string, any>> = [];
    for (;;) {
      const item = await reader.read(); if (item.done) break; buffer += decoder.decode(item.value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
        const event = JSON.parse(line); events.push(event);
        if (event.type === 'approval') {
          if (web) { assert.equal(calls.length, 0); assert.equal(searches, 0); }
          await api('/api/assistant/approve', { id: event.id, allow: true });
        }
      }
    }
    assert.ok(events.some(e => e.type === 'done')); return events;
  };
  try {
    const events = await chat(true); assert.equal(calls.length, 2); assert.equal(searches, 1); assert.equal(reads, 1);
    assert.match(calls[1]!.input.at(-1).content, /Public web evidence/); assert.ok(!JSON.stringify(calls).includes('private history'));
    assert.ok(events.some(e => e.type === 'sources' && e.provider === 'Public page'));
    await chat(false); assert.equal(searches, 1); assert.equal(reads, 1);
    assert.equal(calls.at(-1)!.input.at(-1).content, 'who is Public Person');
  } finally { server.close(); }
});
