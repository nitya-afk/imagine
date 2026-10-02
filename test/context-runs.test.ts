import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { packContext } from '../src/context.ts';
import { RunStore } from '../src/runs.ts';

test('context removes entire old exchanges and keeps current message plus tool pairing', () => {
  const result = packContext([
    { role: 'system', content: 'System' }, { role: 'user', content: 'Old question'.repeat(1000) },
    { role: 'assistant', content: 'Old answer'.repeat(1000) }, { role: 'user', content: 'Current question' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'recall', arguments: { query: '' } } }] },
    { role: 'tool', tool_name: 'recall', content: 'The result' },
  ], [], 1024);
  assert.equal(result.dropped, 2); assert.equal(result.messages.length, 4);
  assert.equal(result.messages[1]!.content, 'Current question'); assert.equal(result.messages[3]!.tool_name, 'recall');
});
test('oversized current user input is rejected, not silently sliced', () => {
  assert.throws(() => packContext([{ role: 'system', content: 'System' }, { role: 'user', content: 'x'.repeat(20_000) }], [], 1024), /not silently truncated/);
});
test('large tool output is visibly shortened with tool pairing intact', () => {
  const result = packContext([{ role: 'user', content: 'Read this' }, { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_webpage', arguments: { url: 'https://example.com' } } }] }, { role: 'tool', tool_name: 'read_webpage', content: 'a'.repeat(30_000) }], [], 1024);
  assert.equal(result.shortened, 1); assert.match(result.messages.at(-1)!.content, /shortened/);
});
test('vision context counts an image allowance rather than base64 text and drops stale screenshots', () => {
  const result = packContext([{ role: 'user', content: 'Look at the screen' }, { role: 'tool', tool_name: 'computer_action', content: 'Old screen', images: ['a'.repeat(2_000_000)] }, { role: 'tool', tool_name: 'computer_action', content: 'Current screen', images: ['b'.repeat(2_000_000)] }], [], 1024);
  assert.equal(result.shortened, 1); assert.equal(result.messages[1]!.images, undefined);
  assert.equal(result.messages[2]!.images?.length, 1); assert.ok(result.estimatedInputTokens < 8192);
});
test('durable run stores final answer and provenance without deltas, thinking or screenshots', () => {
  const directory = mkdtempSync(join(tmpdir(), 'imagine-run-store-')), store = new RunStore(directory);
  const run = store.create('Public question'); store.update(run.id, { state: 'running' });
  store.event(run.id, { type: 'delta', content: 'partial' });
  store.event(run.id, { type: 'sources', provider: 'Brave', results: [{ title: 'Source', url: 'https://example.com' }], images: ['secret pixels'], thinking: 'internal' });
  store.checkpoint(run.id, [{ role: 'system', content: 'Private memory' }, { role: 'user', content: 'Public question' }, { role: 'tool', tool_name: 'whatsapp_recent', content: 'Private message', images: ['secret pixels'] }]);
  store.update(run.id, { state: 'completed', answer: 'Final answer' });
  const restored = new RunStore(directory).get(run.id)!;
  assert.equal(restored.answer, 'Final answer'); assert.equal(restored.events.length, 1);
  const text = readFileSync(join(directory, `${run.id}.json`), 'utf8');
  for (const secret of ['partial', 'secret pixels', 'internal', 'Private memory', 'Private message']) assert.ok(!text.includes(secret));
  assert.equal(statSync(join(directory, `${run.id}.json`)).mode & 0o777, 0o600);
  assert.throws(() => store.update(run.id, { state: 'running' }), /cannot be restarted/);
  assert.equal(store.remove(run.id), true); assert.equal(store.get(run.id), undefined);
});
test('restart marks dead-owner runs interrupted, not other live runs, and never replays', () => {
  const directory = mkdtempSync(join(tmpdir(), 'imagine-run-restart-')), store = new RunStore(directory);
  const dead = store.create('Interrupted action'), live = store.create('Still running');
  const path = join(directory, `${dead.id}.json`);
  writeFileSync(path, JSON.stringify({ ...store.get(dead.id), ownerPid: 99999999, state: 'waiting_approval' }));
  new RunStore(directory).markInterrupted();
  assert.equal(store.get(dead.id)!.state, 'interrupted'); assert.match(store.get(dead.id)!.error!, /not automatically replayed/);
  assert.equal(store.get(live.id)!.state, 'queued'); assert.throws(() => store.remove(live.id), /Stop the active/);
  assert.throws(() => store.get('../../secrets'), /Invalid run ID/);
});
