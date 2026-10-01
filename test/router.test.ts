import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerWithFrontier, chooseRoute, TokenBudget } from '../src/router.ts';

test('smart routing stays local for simple work and chooses a frontier tier for complex work', () => {
  assert.equal(chooseRoute('What is 2 + 2?', 'smart', true).provider, 'local');
  assert.equal(chooseRoute('Debug this TypeScript code and compare the tradeoffs.', 'smart', true).model, 'gpt-6.1-sol');
  assert.equal(chooseRoute(('Analyze this complex Python algorithm, debug it, compare tradeoffs, and design a better architecture. ').repeat(6) + '\nA\nB\nC', 'smart', true).model, 'gpt-6-astra');
  assert.equal(chooseRoute('Code a function', 'smart', false).provider, 'local');
  assert.equal(chooseRoute('Hello', 'frontier', true, 'fast').model, 'gpt-6-luna');
  assert.throws(() => chooseRoute('Hello', 'frontier', false), /not configured/);
});

test('frontier counts input first, caps output, and reconciles real usage', async () => {
  const requests: Array<{ url: string; body: Record<string, any>; headers: HeadersInit | undefined }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const name = String(url);
    const body = JSON.parse(String(init?.body));
    requests.push({ url: name, body, headers: init?.headers });
    if (name.endsWith('/input_tokens')) return new Response(JSON.stringify({ input_tokens: 320 }));
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'A careful answer.' }] }], usage: { input_tokens: 320, output_tokens: 180, total_tokens: 500 } }));
  }) as typeof fetch;
  const budget = new TokenBudget(2000);
  const events: Array<Record<string, unknown>> = [];
  const answer = await answerWithFrontier('Explain this code.', [], { key: 'test-key', model: 'gpt-6.1-sol', maxInputTokens: 1000, maxOutputTokens: 512, budget, fetcher }, (ev) => events.push(ev));
  assert.equal(answer, 'A careful answer.');
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.body.store, false);
  assert.equal(requests[1]!.body.max_output_tokens, 512);
  assert.equal(requests[1]!.body.model, 'gpt-6.1-sol');
  assert.equal(budget.spent, 500);
  assert.equal(events.at(-1)?.type, 'usage');
  assert.ok(!JSON.stringify(requests.map((r) => r.body)).includes('test-key'));
});

test('input and session caps stop a cloud completion before it is sent', async () => {
  const urls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ input_tokens: 900 }));
  }) as typeof fetch;
  const opts = { key: 'test-key', model: 'gpt-6-luna', maxInputTokens: 800, maxOutputTokens: 512, budget: new TokenBudget(2000), fetcher };
  await assert.rejects(answerWithFrontier('A large request', [], opts), /above your 800-token cap/);
  assert.equal(urls.length, 1);
  await assert.rejects(answerWithFrontier('A large request', [], { ...opts, maxInputTokens: 1000, budget: new TokenBudget(1000) }), /budget reached/);
  assert.equal(urls.length, 2);
});

test('frontier includes only recent text history when the caller opts in', async () => {
  const sent: Array<Record<string, any>> = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    if (sent.length === 1) return new Response(JSON.stringify({ input_tokens: 50 }));
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done.' }] }], usage: { total_tokens: 70 } }));
  }) as typeof fetch;
  await answerWithFrontier('Now answer', [{ role: 'user', content: 'Earlier context' }], {
    key: 'test-key', model: 'gpt-6-luna', maxInputTokens: 500, maxOutputTokens: 128, budget: new TokenBudget(1000), fetcher,
  });
  assert.deepEqual(sent[1]?.input, [{ role: 'user', content: 'Earlier context' }, { role: 'user', content: 'Now answer' }]);
});
