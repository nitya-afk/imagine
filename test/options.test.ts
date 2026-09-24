import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { normalizeHost } from '../src/host.ts';
import { imageFileName, parseIntInRange, parseSize, slugify } from '../src/options.ts';

test('parseSize accepts WxH and rejects sizes the model cannot render', () => {
  assert.deepEqual(parseSize('1024x1024'), { width: 1024, height: 1024 });
  assert.deepEqual(parseSize('1536X1024'), { width: 1536, height: 1024 });
  assert.deepEqual(parseSize('512×768'), { width: 512, height: 768 });
  assert.throws(() => parseSize('1000x1000'), /multiple of 16/);
  assert.throws(() => parseSize('128x128'), /between 256 and 2048/);
  assert.throws(() => parseSize('4096x4096'), /between 256 and 2048/);
  assert.throws(() => parseSize('big'), /WIDTHxHEIGHT/);
});

test('parseIntInRange rejects fractions, text and out-of-range values', () => {
  assert.equal(parseIntInRange('4', '--steps', 1, 100), 4);
  assert.throws(() => parseIntInRange('0', '--steps', 1, 100), /--steps/);
  assert.throws(() => parseIntInRange('2.5', '--steps', 1, 100));
  assert.throws(() => parseIntInRange('four', '--steps', 1, 100));
});

test('slugify makes short, filesystem-safe names', () => {
  assert.equal(slugify('A cat blasting off from the SUN!'), 'a-cat-blasting-off-from-the-sun');
  assert.equal(slugify('Café crème brûlée'), 'cafe-creme-brulee');
  assert.equal(slugify('!!!'), 'image');
  const long = slugify('word '.repeat(40));
  assert.ok(long.length <= 60 && !long.endsWith('-'));
});

test('imageFileName is sortable, reproducible and never overwrites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'imagine-'));
  const date = new Date(2026, 8, 24, 14, 35, 25);
  const first = imageFileName(dir, 'a red apple', 42, date);
  assert.equal(first, '20260924-143525-a-red-apple-42.png');
  writeFileSync(join(dir, first), '');
  assert.equal(imageFileName(dir, 'a red apple', 42, date), '20260924-143525-a-red-apple-42-2.png');
});

test('normalizeHost reads OLLAMA_HOST the way Ollama does', () => {
  assert.equal(normalizeHost(undefined), 'http://127.0.0.1:11434');
  assert.equal(normalizeHost(''), 'http://127.0.0.1:11434');
  assert.equal(normalizeHost('0.0.0.0'), 'http://127.0.0.1:11434');
  assert.equal(normalizeHost('127.0.0.1:9000'), 'http://127.0.0.1:9000');
  assert.equal(normalizeHost('http://gpu-box:8080/'), 'http://gpu-box:8080');
  assert.equal(normalizeHost('https://ollama.example.com'), 'https://ollama.example.com');
});
