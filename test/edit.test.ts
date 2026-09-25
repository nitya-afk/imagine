import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectationFor, extendSize, parsePlan, pickVisionModel, promptFor, stepsFromFlags } from '../src/edit.ts';

test('flags become steps in an order that composes well: content first, size last', () => {
  const steps = stepsFromFlags({ extend: '16:9', background: 'a beach', remove: ['the car', 'the sign'], add: ['a dog'], style: 'watercolor', face: 'an older man', swapFace: 'me.jpg' });
  assert.deepEqual(steps.map((s) => s.op), ['remove', 'remove', 'add', 'face', 'swap-face', 'background', 'style', 'extend']);
});

test('each step gets the phrasing that edits best', () => {
  assert.match(promptFor({ op: 'remove', value: 'the lamp' }), /^remove the lamp, .*keep everything else exactly the same$/);
  assert.match(promptFor({ op: 'background', value: 'a beach at sunset' }), /background to a beach at sunset, keep the subject/);
  assert.match(promptFor({ op: 'swap-face', value: 'me.jpg' }), /face of the person in the second image/);
  assert.equal(promptFor({ op: 'custom', value: 'make it snow' }), 'make it snow');
});

test('extending grows the frame in one direction only and stays within limits', () => {
  assert.deepEqual(extendSize(768, 1024, '16:9'), { width: 1824, height: 1024 });
  assert.deepEqual(extendSize(1024, 1024, 'taller'), { width: 1024, height: 1536 });
  assert.deepEqual(extendSize(1024, 1024, 'wider'), { width: 1536, height: 1024 });
  assert.deepEqual(extendSize(1536, 1024, '21:9'), { width: 2048, height: 880 });
  assert.deepEqual(extendSize(512, 512, '1536x1024'), { width: 1536, height: 1024 });
  assert.throws(() => extendSize(512, 512, 'huge'), /Unknown --extend/);
});

test('planner replies are parsed and validated', () => {
  const reply = 'Sure!\n```json\n[{"op":"remove","value":"the lamp"},{"op":"background","value":"a sunny garden"}]\n```';
  assert.deepEqual(parsePlan(reply), [{ op: 'remove', value: 'the lamp' }, { op: 'background', value: 'a sunny garden' }]);
  assert.throws(() => parsePlan('I cannot do that'), /did not return a list/);
  assert.throws(() => parsePlan('[{"op":"teleport","value":"x"}]'), /unknown step "teleport"/);
});

test('only checkable steps get an expectation for the vision model', () => {
  assert.deepEqual(expectationFor({ op: 'remove', value: 'a lamp' }), { question: 'Is there a lamp in this picture?', want: false });
  assert.deepEqual(expectationFor({ op: 'add', value: 'a coffee cup' }), { question: 'Is there a coffee cup in this picture?', want: true });
  assert.equal(expectationFor({ op: 'extend', value: '16:9' }), null);
  assert.equal(expectationFor({ op: 'swap-face', value: 'me.jpg' }), null);
});

test('picks a vision-capable chat model for checking', () => {
  const m = (name: string, size: number, capabilities: string[]) => ({ name, size, capabilities });
  assert.equal(pickVisionModel([m('qwen3.5:0.8b', 1e9, ['completion']), m('gemma4:12b', 7.6e9, ['completion', 'vision']), m('x/flux2-klein', 5.7e9, ['image', 'vision'])]), 'gemma4:12b');
  assert.equal(pickVisionModel([m('qwen3.5:0.8b', 1e9, ['completion'])]), null);
});
