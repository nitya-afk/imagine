import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lookupQuery, parseBrave, parseDuck, publicAddress, publicUrl, safeQuery, urlFromPrompt, WebResearch } from '../src/research.ts';

const brave = `<script>maliciousInstructions()</script><div data-type="ad"><a href="https://ad.example.com">ad</a></div>
<div class="snippet" data-type="web"><a href="https://www.example.com/person"><div class="title search-snippet-title">Nitya <b>Prakhar</b> · Founder</div></a><div class="generic-snippet">A public professional <b>profile</b> &amp; biography.</div></div>`;
const duck = `<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.example.org%2Fdocs">Official <b>docs</b></a><a class="result__snippet">A <b>current</b> release &amp; guide.</a>`;

test('organic Brave parsing keeps titles/snippets and excludes scripts and ads', () => {
  assert.deepEqual(parseBrave(brave), [{ title: 'Nitya Prakhar · Founder', url: 'https://www.example.com/person', snippet: 'A public professional profile & biography.', kind: 'search' }]);
  assert.equal(parseBrave(brave.replace('https://www.example.com/person', 'https://localhost/')).length, 0);
});
test('DuckDuckGo links are unwrapped, decoded and kept as public source records', () => {
  assert.deepEqual(parseDuck(duck), [{ title: 'Official docs', url: 'https://www.example.org/docs', snippet: 'A current release & guide.', kind: 'search' }]);
});
test('lookup triggers named/current public questions, never saved memory or credentials', () => {
  assert.equal(lookupQuery('who is nitya prakhar'), 'who is nitya prakhar');
  assert.equal(lookupQuery('Find the latest TypeScript release'), 'Find the latest TypeScript release');
  assert.equal(lookupQuery('What is 2 + 2?'), undefined);
  assert.equal(lookupQuery('Explain obscure public term', true), 'Explain obscure public term');
  for (const text of ['who is my colleague', 'Search my WhatsApp messages', 'latest API key sk-supersecretkey123456', 'Read /Users/me/private.txt', 'Search for person@example.com']) assert.equal(lookupQuery(text, true), undefined);
  assert.throws(() => safeQuery('token\nprivate data'), /short public terms/);
});
test('search falls back on challenge/HTTP failures and marks Wikipedia as limited', async () => {
  const urls: string[] = [], events: Array<Record<string, unknown>> = [];
  const fetcher = (async (url: string | URL | Request) => {
    urls.push(String(url));
    if (String(url).includes('api.search.brave')) return new Response('', { status: 429 });
    if (String(url).includes('search.brave.com')) return new Response('<title>Just a moment</title>');
    if (String(url).includes('duckduckgo')) return new Response('<div class="anomaly-modal">Challenge</div>');
    return Response.json({ query: { search: [{ title: 'A title', pageid: 100, snippet: '<b>Limited</b> encyclopedia content' }] } });
  }) as typeof fetch;
  const research = new WebResearch({ fetcher, key: 'test-key', emit: e => events.push(e) });
  const report = await research.search('obscure public name');
  assert.equal(report.coverage, 'limited'); assert.equal(report.provider, 'Wikipedia'); assert.equal(report.attempts.length, 4);
  assert.match(report.note, /do not establish/); assert.equal(urls.length, 4);
  assert.equal(await research.search('obscure public name'), report); assert.equal(urls.length, 4);
  assert.ok(events.some(e => e.type === 'sources'));
});
test('keyless broad search works without Wikipedia and page failures stay explicit', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(brave); }) as typeof fetch;
  const research = new WebResearch({ fetcher, key: '', reader: async () => { throw new Error('Login required'); } });
  const evidence = JSON.parse(await research.evidence('who is nitya prakhar'));
  assert.equal(calls, 1); assert.equal(evidence.search.coverage, 'broad');
  assert.equal(evidence.search.results[0].title, 'Nitya Prakhar · Founder');
  assert.equal(evidence.pages[0].error, 'Login required'); assert.match(evidence.pages[0].note, /do not claim/);
});
test('empty retrieval tries a shorter entity query and never claims absence of public presence', async () => {
  const urls: string[] = [];
  const research = new WebResearch({ key: '', fetcher: (async (url: string | URL | Request) => {
    urls.push(String(url)); return String(url).includes('wikipedia') ? Response.json({ query: { search: [] } }) : new Response('<html>No results</html>');
  }) as typeof fetch });
  const evidence = JSON.parse(await research.evidence('who is Unknown Person?'));
  assert.equal(evidence.search.coverage, 'unavailable'); assert.equal(evidence.search.query, 'Unknown Person');
  assert.equal(urls.length, 6); assert.match(evidence.instructions, /do not infer nonexistence/);
  assert.match(research.groundingIssue('This person is not widely known and has no public presence.', 'who is Unknown Person?')!, /missing result/);
});
test('private endpoints, credentials, custom ports and non-HTTPS addresses are rejected', () => {
  for (const url of ['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://example.com:444', 'https://user:pass@example.com', 'https://foo.local', 'https://metadata.internal']) assert.throws(() => publicUrl(url));
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '172.16.0.1', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fe90::1', 'fd00::1']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('93.184.216.34'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
  assert.throws(() => publicUrl('https://example.com/?api_key=secret'), /Credential-bearing/);
  assert.equal(urlFromPrompt('Please read https://example.com/docs.'), 'https://example.com/docs');
  assert.equal(urlFromPrompt('Read https://localhost/'), undefined);
});
test('failed first sources lead to an alternative page rather than stopping at blocked pages', async () => {
  const cards = Array.from({ length: 4 }, (_, i) => brave.replaceAll('www.example.com/person', `www.example.com/person${i}`)).join('');
  const urls: string[] = [];
  const research = new WebResearch({ key: '', fetcher: (async () => new Response(cards)) as typeof fetch, reader: async url => {
    urls.push(url); if (/person[01]$/.test(url)) throw new Error('Blocked');
    return { url, title: 'Open profile', text: 'Public profile text', links: [], truncated: false, format: 'html' };
  } });
  const evidence = JSON.parse(await research.evidence('who is a public person'));
  assert.equal(urls.length, 4); assert.equal(evidence.pages.filter((p: { text?: string }) => p.text).length, 2);
});
test('identity retrieval prioritizes professional profiles over contradictory directories', async () => {
  const cards = brave.replace('www.example.com/person', 'in.linkedin.com/in/nityaprakhar') + brave.replace('www.example.com/person', 'peerlist.io/nitya_wrrki') + brave.replace('www.example.com/person', 'www.crunchbase.com/person/nitya-prakhar').replace('A public professional <b>profile</b>', 'Founder of a conflicting company');
  const read: string[] = [];
  const research = new WebResearch({ key: '', fetcher: (async () => new Response(cards)) as typeof fetch, reader: async url => {
    read.push(url); return { url, title: 'Professional profile', text: 'Professional public information', links: [], truncated: false, format: 'html' };
  } });
  const evidence = JSON.parse(await research.evidence('who is nitya prakhar'));
  assert.equal(evidence.search.results.length, 2); assert.equal(read.length, 2);
  assert.ok(!JSON.stringify(evidence).includes('conflicting company')); assert.ok(!research.citationContext().includes('crunchbase'));
  assert.match(research.groundingIssue('Bio [Source](https://www.crunchbase.com/person/nitya-prakhar)', 'who is nitya prakhar')!, /citation|identity source/);
  assert.match(research.groundingIssue('She is a founder [Source](https://peerlist.io/nitya_wrrki)', 'who is nitya prakhar')!, /gender/);
});
test('cancellation does not continue through search fallbacks', async () => {
  const controller = new AbortController(); let calls = 0;
  const research = new WebResearch({ signal: controller.signal, key: '', fetcher: (async () => { calls++; controller.abort(); throw new Error('Cancelled'); }) as typeof fetch });
  await assert.rejects(research.search('latest public information')); assert.equal(calls, 1);
});
test('shared web budget rejects new queries after eight but caches repeated queries', async () => {
  const research = new WebResearch({ key: '', fetcher: (async () => new Response(brave)) as typeof fetch });
  for (let i = 0; i < 8; i++) await research.search(`public query ${i}`);
  assert.equal((await research.search('public query 0')).results.length, 1);
  await assert.rejects(research.search('ninth query'), /budget/);
});
