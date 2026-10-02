import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import { createUiServer } from '../src/ui.ts';
import { RunStore } from '../src/runs.ts';

const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');

test('the field guide has ten linked chapters, valid controls and a bundled reference', () => {
  const links = [...html.matchAll(/href="#(guide-[\w-]+)"/g)].map(m => m[1]!);
  assert.equal(links.length, 10);
  for (const id of links) assert.ok(html.includes(`id="${id}"`), id);
  for (const match of html.matchAll(/data-guide-setting="([\w-]+)"/g)) assert.ok(html.includes(`id="${match[1]}"`), match[1]!);
  assert.match(html, /href="\/guide\/assistant"/);
  assert.match(html, /not the full chat/);
  assert.match(html, /not encrypted/);
  assert.match(html, /never send a request or enable a tool automatically/);
});

function guideHarness() {
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', textContent: '', open: false, checked: false, focused: false, events: [] as string[], listeners: {} as Record<string, Function>,
      addEventListener(name: string, callback: Function) { this.listeners[name] = callback; },
      close() { this.open = false; this.listeners.close?.(); }, showModal() { this.open = true; },
      dispatchEvent(event: Event) { this.events.push(event.type); }, focus() { this.focused = true; }, scrollIntoView() {},
    });
    return nodes.get(id);
  };
  const buttons = [...html.matchAll(/<button[^>]*data-guide-(prompt|setting)="([^"]+)"[^>]*>/g)].map(m => ({
    dataset: { [m[1] === 'prompt' ? 'guidePrompt' : 'guideSetting']: m[2] },
    click: () => {}, addEventListener(_name: string, callback: () => void) { this.click = callback; },
  }));
  node('guide-modal').querySelectorAll = () => buttons;
  const state = { busy: false }, tabs: string[] = [];
  let confirmed = true, confirmations = 0;
  const source = html.slice(html.indexOf("const guide = $('guide-modal');"), html.indexOf('/** Read a newline-delimited JSON stream'));
  runInNewContext(source, { $: node, state, Event, localStorage: { setItem() {} }, selectTab: (name: string) => tabs.push(name), confirm: () => { confirmations++; return confirmed; } });
  return { node, buttons, state, tabs, setConfirm: (value: boolean) => { confirmed = value; }, confirmations: () => confirmations };
}

test('guide examples only prepare drafts; existing drafts and running jobs are protected', () => {
  const h = guideHarness(), example = h.buttons.find(b => b.dataset.guidePrompt)!;
  h.node('guide-modal').showModal(); example.click();
  assert.equal(h.node('assistant-prompt').value, example.dataset.guidePrompt);
  assert.deepEqual(h.node('assistant-prompt').events, ['input']);
  assert.equal(h.node('assistant-prompt').focused, true);
  assert.deepEqual(h.tabs, ['assistant']);
  assert.equal(h.node('guide-modal').open, false);

  h.node('assistant-prompt').value = 'My existing draft'; h.node('guide-modal').showModal(); h.setConfirm(false);
  example.click();
  assert.equal(h.confirmations(), 1); assert.equal(h.node('assistant-prompt').value, 'My existing draft');
  assert.equal(h.node('guide-modal').open, true);

  h.setConfirm(true); h.state.busy = true; example.click();
  assert.equal(h.confirmations(), 1); assert.equal(h.node('assistant-prompt').value, 'My existing draft');
  assert.match(h.node('guide-action-status').textContent, /Finish or stop/);
});

test('guide setting shortcuts focus controls without granting permissions', () => {
  const h = guideHarness(), button = h.buttons.find(b => b.dataset.guideSetting === 'assistant-computer')!;
  h.node('guide-modal').showModal(); button.click();
  assert.equal(h.node('assistant-settings').open, true);
  assert.equal(h.node('assistant-computer').focused, true);
  assert.equal(h.node('assistant-computer').checked, false);
  assert.equal(h.node('guide-modal').open, false);
  assert.deepEqual(h.tabs, ['assistant']);
  h.state.busy = true; h.node('guide-modal').showModal(); button.click();
  assert.equal(h.node('guide-modal').open, true);
});

test('the full guide is served offline without exposing the token or arbitrary files', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'imagine-guide-test-'));
  const { server, token } = createUiServer({ version: 'test', outputDir: folder, defaultModel: 'test', generate: async () => Buffer.alloc(0), listImageModels: async () => [], assistantRuns: new RunStore(join(folder, 'runs')) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(base + '/guide/assistant');
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/plain/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const guide = await response.text();
    assert.equal(guide, readFileSync(new URL('../docs/ASSIST.md', import.meta.url), 'utf8'));
    assert.ok(!guide.includes(token)); assert.match(guide, /## Troubleshooting/); assert.match(guide, /## Capability checklist/);
    assert.equal((await fetch(base + '/guide/other')).status, 404);
    assert.equal((await fetch(base + '/api/assistant/memory')).status, 401);
  } finally { server.close(); }
});
