import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseQuantize } from '../src/create.ts';
import { canonicalModel, memoryFit, normalizeModelName, withTag } from '../src/models.ts';

const GB = 1e9;

test('short names resolve into the x/ namespace only for library image models', () => {
  assert.equal(normalizeModelName('flux2-klein:9b-fp4'), 'x/flux2-klein:9b-fp4');
  assert.equal(normalizeModelName('z-image-turbo'), 'x/z-image-turbo');
  assert.equal(normalizeModelName('x/flux2-klein'), 'x/flux2-klein');
  assert.equal(normalizeModelName('my-flux-nvfp4'), 'my-flux-nvfp4');
  assert.equal(normalizeModelName('someone/flux2-klein'), 'someone/flux2-klein');
});

test('aliases resolve to the variant they point at', () => {
  assert.equal(canonicalModel('x/flux2-klein'), 'x/flux2-klein:4b-fp4');
  assert.equal(canonicalModel('x/flux2-klein:latest'), 'x/flux2-klein:4b-fp4');
  assert.equal(canonicalModel('x/flux2-klein:9b'), 'x/flux2-klein:9b-fp4');
  assert.equal(canonicalModel('x/z-image-turbo'), 'x/z-image-turbo:fp8');
  assert.equal(canonicalModel('x/flux2-klein:4b-bf16'), 'x/flux2-klein:4b-bf16');
  assert.equal(withTag('localhost:5000/model'), 'localhost:5000/model:latest');
});

test('memory fit follows the engine limit of about three quarters of RAM', () => {
  const ram = 24 * GB;
  assert.equal(memoryFit(5.73 * GB, ram), 'fits');
  assert.equal(memoryFit(11.97 * GB, ram), 'fits');
  assert.equal(memoryFit(15.98 * GB, ram), 'tight');
  assert.equal(memoryFit(20.24 * GB, ram), 'too big');
  assert.equal(memoryFit(34.72 * GB, 64 * GB), 'tight');
});


test('create accepts the formats the engine has kernels for', () => {
  assert.equal(parseQuantize('INT4'), 'int4');
  assert.equal(parseQuantize('int8'), 'int8');
  for (const unsupported of ['nvfp4', 'mxfp8', 'mxfp4', 'q4_K_M']) {
    assert.throws(() => parseQuantize(unsupported), /Use one of: int4, int8/);
  }
});
