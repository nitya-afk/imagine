import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LocalAssistant, MemoryStore, pickAssistantModel } from '../src/assistant.ts';
import { describeComputerAction } from '../src/computer.ts';
import { WhatsAppBridge } from '../src/whatsapp.ts';

const models = [
  { name: 'qwen3.5:4b', size: 3.4e9, capabilities: ['completion', 'tools'] },
  { name: 'qwen3.5:9b', size: 6.6e9, capabilities: ['completion', 'tools'] },
];

test('selects 4B for 8 GB and 9B for 16 GB when installed', () => {
  assert.equal(pickAssistantModel(models, 8e9), 'qwen3.5:4b');
  assert.equal(pickAssistantModel(models, 16e9), 'qwen3.5:9b');
  assert.equal(pickAssistantModel([{ name: 'huihui_ai/qwen3.5-abliterated:4b', size: 3.3e9, capabilities: ['completion'] }], 8e9), 'huihui_ai/qwen3.5-abliterated:4b');
});

test('persistent memory saves, deduplicates and removes local facts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imagine-assistant-test-'));
  const path = join(dir, 'memory.json');
  const store = new MemoryStore(path);
  const item = store.add('Prefer concise answers');
  assert.equal(store.add('prefer concise answers').id, item.id);
  assert.deepEqual(new MemoryStore(path).list().map((m) => m.text), ['Prefer concise answers']);
  assert.equal(store.remove(item.id), true);
  assert.deepEqual(store.list(), []);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), []);
  assert.throws(() => store.add('Remember my API key is abc123'), /Do not save/);
});

test('tool loop reads project files and returns their contents to the model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imagine-agent-project-'));
  writeFileSync(join(dir, 'sample.txt'), 'The answer is in this file.');
  const requests: Array<Record<string, any>> = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const message = requests.length === 1
      ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_project_file', arguments: { path: 'sample.txt' } } }] }
      : { role: 'assistant', content: 'The file says: The answer is in this file.' };
    return new Response(JSON.stringify({ message }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const assistant = new LocalAssistant({ projectDir: dir, fetcher, web: false, projectFiles: true });
  const answer = await assistant.run('Read sample.txt.');
  assert.match(answer, /The file says/);
  assert.equal(requests[1]!.messages.at(-1).content, 'The answer is in this file.');
  assert.ok(!requests[0]!.tools.some((tool: any) => tool.function.name === 'web_search'));
});

test('project reading cannot leave its root, and computer action needs approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imagine-agent-project-'));
  const calls = [
    { function: { name: 'read_project_file', arguments: { path: '../outside.txt' } } },
    { function: { name: 'computer_action', arguments: { action: 'open_app', app: 'Notes' } } },
  ];
  const requests: Array<Record<string, any>> = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const message = requests.length === 1 ? { role: 'assistant', content: '', tool_calls: calls } : { role: 'assistant', content: 'Done.' };
    return new Response(JSON.stringify({ message }));
  }) as typeof fetch;
  const assistant = new LocalAssistant({ projectDir: dir, fetcher, computer: true, projectFiles: true, approve: async () => false });
  assert.equal(await assistant.run('Check the file and open Notes.'), 'Done.');
  const messages = requests[1]!.messages;
  assert.match(messages.at(-2).content, /Tool error/);
  assert.match(messages.at(-1).content, /did not approve/);
  assert.equal(describeComputerAction({ action: 'open_app', app: 'Notes' }), 'Open the app “Notes”');
});

test('specialist worker runs as a bounded separate conversation', async () => {
  const requests: Array<Record<string, any>> = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const message = requests.length === 1
      ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'delegate', arguments: { task: 'Check the arithmetic', specialty: 'reasoning' } } }] }
      : requests.length === 2 ? { role: 'assistant', content: 'The specialist found 2 + 2 = 4.' }
      : { role: 'assistant', content: 'A specialist confirmed the result is 4.' };
    return new Response(JSON.stringify({ message }));
  }) as typeof fetch;
  const assistant = new LocalAssistant({ fetcher, workers: true, web: false });
  assert.match(await assistant.run('What is 2 + 2?'), /confirmed/);
  assert.equal(requests.length, 3);
  assert.ok(requests[0]!.tools.some((tool: any) => tool.function.name === 'delegate'));
  assert.ok(!requests[1]!.tools.some((tool: any) => tool.function.name === 'delegate'));
  assert.match(requests[2]!.messages.at(-1).content, /specialist found/);
});

test('WhatsApp is disconnected until the user pairs it, and cannot send before then', async () => {
  const bridge = new WhatsAppBridge();
  assert.equal(bridge.status().state, 'disconnected');
  await assert.rejects(bridge.send('1234567890', 'hi'), /not connected/);
  await bridge.stop();
  assert.equal(bridge.status().state, 'disconnected');
});
