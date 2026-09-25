import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanPrompt, pickChatModel } from '../src/enhance.ts';

const model = (name: string, size: number, capabilities: string[]) => ({ name, size, capabilities });

test('picks the largest chat model that loads comfortably, never an image model', () => {
  const models = [
    model('x/flux2-klein:latest', 5.7e9, ['image']),
    model('gemma4:12b', 7.6e9, ['completion', 'vision']),
    model('qwen3.5:0.8b', 1e9, ['completion']),
    model('huge:70b', 40e9, ['completion']),
    model('embed', 0.3e9, ['embedding']),
  ];
  assert.equal(pickChatModel(models), 'gemma4:12b');
  assert.equal(pickChatModel([model('huge:70b', 40e9, ['completion']), model('big:32b', 20e9, ['completion'])]), 'big:32b');
  assert.equal(pickChatModel([model('x/flux2-klein', 5.7e9, ['image'])]), null);
});

test('cleans what chat models wrap around a prompt', () => {
  assert.equal(cleanPrompt('"A cat in a spacesuit, soft light."'), 'A cat in a spacesuit, soft light.');
  assert.equal(cleanPrompt('Here is your prompt:\nA cat in a spacesuit.\n\nThis prompt emphasises…'), 'A cat in a spacesuit.');
  assert.equal(cleanPrompt('<think>hmm, ok</think>\nPrompt: **A cat in a spacesuit**'), 'A cat in a spacesuit');
  assert.equal(cleanPrompt('a  cat\n in   space'), 'a cat in space');
  assert.ok(cleanPrompt('word '.repeat(300)).length <= 600);
});
