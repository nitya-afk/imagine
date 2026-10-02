import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assistantModels, LocalAssistant, MemoryStore, pickAssistantModel } from '../src/assistant.ts';
import { describeComputerAction } from '../src/computer.ts';
import { WhatsAppBridge } from '../src/whatsapp.ts';

const models = [
  { name: 'qwen3.5:4b', size: 3.4e9, capabilities: ['completion', 'tools'] },
  { name: 'qwen3.5:9b', size: 6.6e9, capabilities: ['completion', 'tools'] },
];
test('real-style tags without capabilities discover chat models via show and enforce memory headroom', async () => {
  const shown: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [...models.map(({ name, size }) => ({ name, size })), { name: 'image', size: 2e9 }, { name: 'too-large', size: 40e9 }] });
    const { model } = JSON.parse(String(init?.body)); shown.push(model);
    return Response.json({ capabilities: model === 'image' ? ['image'] : ['completion', 'tools'] });
  }) as typeof fetch;
  const info = await assistantModels('http://127.0.0.1:11434', fetcher, 16e9);
  assert.equal(info.defaultModel, 'qwen3.5:9b'); assert.equal(info.models.length, 2); assert.ok(!shown.includes('too-large'));
});

const searchCard = '<div data-type="web"><a href="https://example.com/nitya"><div class="search-snippet-title">Nitya Prakhar · Public profile</div></a><div class="generic-snippet">Founder of a software company.</div></div>';
const pageReader = async (url: string) => ({ url, title: 'Public profile', text: 'Nitya Prakhar is a software founder.', links: [], truncated: false, format: 'html' });

test('named-person question retrieves web evidence before the first local generation', async () => {
  const requests: Array<Record<string, any>> = [], urls: string[] = [], events: Array<Record<string, unknown>> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    if (!String(url).includes('/api/chat')) return new Response(searchCard);
    const body = JSON.parse(String(init?.body)); if (body.messages.length) requests.push(body);
    return Response.json({ message: { role: 'assistant', content: 'A software founder. [Public profile](https://example.com/nitya)' } });
  }) as typeof fetch;
  const answer = await new LocalAssistant({ fetcher, webReader: pageReader }).run('who is nitya prakhar', [], e => events.push(e));
  assert.match(answer, /software founder/); assert.ok(urls[0]!.includes('search.brave.com'));
  assert.match(requests[0]!.messages.at(-1).content, /Public web evidence/);
  assert.match(requests[0]!.messages.at(-1).content, /Nitya Prakhar is a software founder/);
  assert.ok(events.some(e => e.type === 'sources' && e.provider === 'Public page'));
});
test('uncertain answer automatically retries with public evidence, not history or memory', async () => {
  let calls = 0; const urls: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes('/api/chat')) { urls.push(String(url)); return new Response(searchCard); }
    const body = JSON.parse(String(init?.body)); if (!body.messages.length) return Response.json({});
    return Response.json({ message: { role: 'assistant', content: ++calls === 1 ? "I don't know that public term." : 'Here is the source-backed explanation. [Source](https://example.com/nitya)' } });
  }) as typeof fetch;
  const answer = await new LocalAssistant({ fetcher, webReader: pageReader }).run('Explain Zorblax protocol', [{ role: 'user', content: 'A private prior conversation.' }]);
  assert.match(answer, /source-backed/); assert.equal(calls, 2); assert.equal(urls.length, 1);
  assert.ok(!decodeURIComponent(urls.join(' ')).includes('private prior'));
});
test('web off prevents both proactive lookup and uncertainty fallback', async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => { urls.push(String(url)); return Response.json({ message: { role: 'assistant', content: "I don't know." } }); }) as typeof fetch;
  await new LocalAssistant({ fetcher, web: false }).run('who is nitya prakhar');
  assert.ok(urls.every(url => url.includes('/api/chat')));
});
test('local prompt length fails explicitly before any model or web call', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; throw new Error('Must not call'); }) as typeof fetch;
  await assert.rejects(new LocalAssistant({ fetcher }).run('x'.repeat(12001)), /nothing was silently truncated/); assert.equal(calls, 0);
});
test('uncited/unsupported identity answer is repaired once then replaced with actual source links', async () => {
  let calls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes('/api/chat')) return new Response(searchCard);
    const body = JSON.parse(String(init?.body)); if (body.messages.length) calls++;
    return Response.json({ message: { role: 'assistant', content: 'These are two different individuals. [Source](https://example.com/nitya)' } });
  }) as typeof fetch;
  const answer = await new LocalAssistant({ fetcher, webReader: pageReader }).run('who is nitya prakhar');
  assert.equal(calls, 2); assert.match(answer, /I found these public sources/); assert.match(answer, /https:\/\/example.com\/nitya/);
  assert.ok(!answer.includes('two different individuals'));
});

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

test('a forged project tool call cannot bypass the disabled project switch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imagine-disabled-project-'));
  writeFileSync(join(dir, 'private.txt'), 'This must not reach the model.');
  const requests: Array<Record<string, any>> = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    return new Response(JSON.stringify({ message: requests.length === 1
      ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_project_file', arguments: { path: 'private.txt' } } }] }
      : { role: 'assistant', content: 'Access denied.' } }));
  }) as typeof fetch;
  await new LocalAssistant({ projectDir: dir, fetcher, projectFiles: false, web: false }).run('Read private.txt');
  assert.match(requests[1]!.messages.at(-1).content, /disabled tool/);
  assert.ok(!JSON.stringify(requests).includes('This must not reach the model.'));
});

test('workers cannot execute parent computer permissions or memory writes', async () => {
  let approvals = 0;
  const requests: Array<Record<string, any>> = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    const tool = (name: string, args: object) => ({ function: { name, arguments: args } });
    const message = requests.length === 1 ? { role: 'assistant', content: '', tool_calls: [tool('delegate', { task: 'Check this', specialty: 'research' })] }
      : requests.length === 2 ? { role: 'assistant', content: '', tool_calls: [tool('computer_action', { action: 'open_app', app: 'Notes' }), tool('remember', { fact: 'Worker changed memory' })] }
      : { role: 'assistant', content: 'Finished.' };
    return new Response(JSON.stringify({ message }));
  }) as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), 'imagine-worker-permissions-'));
  const memory = new MemoryStore(join(dir, 'memory.json'));
  await new LocalAssistant({ fetcher, memory, workers: true, computer: true, web: false, approve: async () => { approvals++; return false; } }).run('Remember to delegate this research');
  assert.equal(approvals, 0);
  assert.deepEqual(memory.list(), []);
  assert.ok(requests[2]!.messages.filter((m: any) => m.role === 'tool').every((m: any) => /disabled tool/.test(m.content)));
});

test('local streaming preserves tool calls and thinking while emitting only answer text', async () => {
  const requests: Array<Record<string, any>> = [], events: Array<Record<string, unknown>> = [];
  const packet = (message: object, done = false) => JSON.stringify({ message, done }) + '\n';
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    const data = requests.length === 1
      ? packet({ thinking: 'Private reasoning', content: '' }) + packet({ tool_calls: [{ function: { name: 'recall', arguments: { query: '' } } }] }, true)
      : packet({ content: 'A streamed ' }) + packet({ content: 'answer.' }, true);
    const bytes = new TextEncoder().encode(data);
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(bytes.slice(0, 19)); stream.enqueue(bytes.slice(19)); stream.close(); } }), { headers: { 'content-type': 'application/x-ndjson' } });
  }) as typeof fetch;
  const answer = await new LocalAssistant({ fetcher, web: false }).run('Say hello', [], event => events.push(event));
  assert.equal(answer, 'A streamed answer.');
  assert.equal(requests[0]!.stream, true);
  assert.equal(requests[1]!.messages.at(-2).thinking, 'Private reasoning');
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.content).join(''), answer);
  assert.ok(!JSON.stringify(events).includes('Private reasoning'));
});

test('an aborted local request stops before another tool can execute', async () => {
  const controller = new AbortController(), events: string[] = [];
  const fetcher = (async () => {
    controller.abort();
    return new Response(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'recall', arguments: { query: '' } } }] } }));
  }) as typeof fetch;
  await assert.rejects(new LocalAssistant({ fetcher, web: false, signal: controller.signal }).run('Read memory', [], event => events.push(event.type)), /abort/i);
  assert.ok(!events.includes('tool'));
});
