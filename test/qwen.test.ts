import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QWEN_FILES, QWEN_MODEL } from '../src/config.ts';
import { isQwenModel, qwenArgs } from '../src/qwen.ts';

test('recognizes the Qwen model and its short alias', () => {
  assert.equal(isQwenModel(QWEN_MODEL), true);
  assert.equal(isQwenModel('qwen-image-2.1-uncensored'), true);
  assert.equal(isQwenModel('x/flux2-klein'), false);
});

test('builds a stable-diffusion.cpp Qwen command', () => {
  const args = qwenArgs(
    { model: QWEN_MODEL, prompt: 'a fox', width: 640, height: 640, steps: 20, cache: true, seed: 42 },
    '/tmp/out.png',
    ['/tmp/ref.png'],
  );
  assert.ok(args.some((arg) => arg.endsWith(QWEN_FILES.diffusion)));
  assert.deepEqual(args.slice(args.indexOf('--width'), args.indexOf('--width') + 4), ['--width', '640', '--height', '640']);
  assert.ok(args.includes('--negative-prompt'));
  assert.equal(args.includes('--offload-to-cpu'), false);
  assert.deepEqual(args.slice(-2), ['--ref-image', '/tmp/ref.png']);
  assert.ok(args.includes('--cache-mode'));
  const mask = args[args.indexOf('--scm-mask') + 1];
  assert.ok(mask);
  assert.equal(mask.split(',').length, 20);
});

test('quality mode keeps every denoising step exact', () => {
  const args = qwenArgs(
    { model: QWEN_MODEL, prompt: 'a fox', width: 1024, height: 1024, steps: 25, cache: false, seed: 42 },
    '/tmp/out.png',
  );
  assert.equal(args.includes('--cache-mode'), false);
});

test('rejects Qwen dimensions that are not divisible by 32', () => {
  assert.throws(
    () => qwenArgs({ model: QWEN_MODEL, prompt: 'x', width: 1008, height: 1024, seed: 1 }, '/tmp/out.png'),
    /divisible by 32/,
  );
});
