import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withImageBackend, type BackendDeps } from '../src/backend.ts';
import { OllamaError } from '../src/ollama.ts';

const MAIN = 'http://main';
const ENGINE = 'http://engine';
const REMOVED = new OllamaError('image generation models are not currently supported', 400);

function deps(overrides: Partial<BackendDeps> = {}) {
  const unsupported = new Set<string>();
  let engineStarts = 0;
  const d: BackendDeps = {
    mainHost: MAIN,
    getVersion: async () => '0.34.2',
    startEngine: async () => {
      engineStarts++;
      return ENGINE;
    },
    isUnsupported: (v) => unsupported.has(v),
    markUnsupported: (v) => unsupported.add(v),
    ...overrides,
  };
  return { d, unsupported, engineStarts: () => engineStarts };
}

test('uses the normal Ollama when it can generate images', async () => {
  const { d, engineStarts } = deps();
  const hosts: string[] = [];
  const result = await withImageBackend(async (host) => (hosts.push(host), 'png'), d);
  assert.equal(result, 'png');
  assert.deepEqual(hosts, [MAIN]);
  assert.equal(engineStarts(), 0);
});

test('falls back to the engine when image generation was removed, and remembers it', async () => {
  const { d, unsupported } = deps();
  const hosts: string[] = [];
  const fn = async (host: string) => {
    hosts.push(host);
    if (host === MAIN) throw REMOVED;
    return 'png';
  };
  assert.equal(await withImageBackend(fn, d), 'png');
  assert.deepEqual(hosts, [MAIN, ENGINE]);
  assert.ok(unsupported.has('0.34.2'));

  hosts.length = 0;
  await withImageBackend(fn, d);
  assert.deepEqual(hosts, [ENGINE], 'a version known to lack images is not retried');
});

test('tries the normal Ollama again after it is upgraded', async () => {
  const { d, unsupported } = deps({ getVersion: async () => '0.40.0' });
  unsupported.add('0.34.2');
  const hosts: string[] = [];
  await withImageBackend(async (host) => (hosts.push(host), 'png'), d);
  assert.deepEqual(hosts, [MAIN]);
});

test('uses the engine when the normal Ollama is not running', async () => {
  const { d } = deps({ getVersion: async () => null });
  const hosts: string[] = [];
  await withImageBackend(async (host) => (hosts.push(host), 'png'), d);
  assert.deepEqual(hosts, [ENGINE]);
});

test('other errors from the normal Ollama are not swallowed', async () => {
  const { d, engineStarts } = deps();
  const missing = new OllamaError('model "x/nope" not found, try pulling it first', 404);
  await assert.rejects(
    withImageBackend(async () => {
      throw missing;
    }, d),
    missing,
  );
  assert.equal(engineStarts(), 0);
});

test('IMAGINE_OLLAMA_HOST overrides everything', async () => {
  const { d, engineStarts } = deps({ overrideHost: 'http://gpu-box:11434' });
  const hosts: string[] = [];
  await withImageBackend(async (host) => (hosts.push(host), 'png'), d);
  assert.deepEqual(hosts, ['http://gpu-box:11434']);
  assert.equal(engineStarts(), 0);
});

test('edits always go to imagine-engine, even when the normal Ollama can generate', async () => {
  const { d } = deps();
  const hosts: string[] = [];
  await withImageBackend(async (host) => (hosts.push(host), 'png'), d, { editing: true });
  assert.deepEqual(hosts, [ENGINE]);
});

test('IMAGINE_OLLAMA_HOST also takes edits', async () => {
  const { d } = deps({ overrideHost: 'http://gpu-box:11434' });
  const hosts: string[] = [];
  await withImageBackend(async (host) => (hosts.push(host), 'png'), d, { editing: true });
  assert.deepEqual(hosts, ['http://gpu-box:11434']);
});
