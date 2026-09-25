import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  decodeTensor,
  encodeTensor,
  loraModules,
  mergeLoras,
  parseLoraArg,
  readSafetensorsHeader,
  targetsFor,
} from '../src/lora.ts';

/** Write a safetensors file from { name: [dtype, shape, values] }. */
function writeSafetensors(path: string, tensors: Record<string, [string, number[], number[]]>): void {
  const header: Record<string, unknown> = {};
  const parts: Buffer[] = [];
  let offset = 0;
  for (const [name, [dtype, shape, values]] of Object.entries(tensors)) {
    const bytes = encodeTensor(Float32Array.from(values), dtype);
    header[name] = { dtype, shape, data_offsets: [offset, offset + bytes.length] };
    parts.push(bytes);
    offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(json.length));
  writeFileSync(path, Buffer.concat([length, json, ...parts]));
}

function readTensor(path: string, name: string): Float32Array {
  const info = readSafetensorsHeader(path).get(name)!;
  return decodeTensor(readFileSync(path).subarray(info.start, info.end), info.dtype);
}

const range = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

test('bf16, f16 and f32 round-trip', () => {
  const values = Float32Array.from([0, 1, -2.5, 0.1, 3.75, -0.0078125]);
  for (const dtype of ['F32', 'BF16', 'F16']) {
    const back = decodeTensor(encodeTensor(values, dtype), dtype);
    values.forEach((v, i) => assert.ok(Math.abs(back[i]! - v) <= Math.abs(v) * 0.01 + 1e-3, `${dtype} ${v} → ${back[i]}`));
  }
});

test('reads diffusers, ai-toolkit and kohya-style LoRA keys', () => {
  const { modules, ignored } = loraModules([
    'transformer.transformer_blocks.0.attn.to_q.lora_A.weight',
    'transformer.transformer_blocks.0.attn.to_q.lora_B.weight',
    'diffusion_model.double_blocks.1.img_attn.qkv.lora_A.weight',
    'diffusion_model.double_blocks.1.img_attn.qkv.lora_B.weight',
    'single_blocks.2.linear1.lora_down.weight',
    'single_blocks.2.linear1.lora_up.weight',
    'single_blocks.2.linear1.alpha',
    'something.else',
  ]);
  assert.deepEqual(modules.map((m) => m.name).sort(), ['double_blocks.1.img_attn.qkv', 'single_blocks.2.linear1', 'transformer_blocks.0.attn.to_q']);
  assert.equal(modules.find((m) => m.name === 'single_blocks.2.linear1')!.alpha, 'single_blocks.2.linear1.alpha');
  assert.deepEqual(ignored, ['something.else']);
});

test('fused BFL qkv splits onto the three diffusers layers', () => {
  const base = new Map([
    ['transformer_blocks.1.attn.to_q.weight', { shape: [4, 3] }],
    ['transformer_blocks.1.attn.to_k.weight', { shape: [4, 3] }],
    ['transformer_blocks.1.attn.to_v.weight', { shape: [4, 3] }],
    ['single_transformer_blocks.0.attn.to_out.weight', { shape: [3, 9] }],
  ]);
  assert.deepEqual(targetsFor('double_blocks.1.img_attn.qkv', 12, base), [
    { key: 'transformer_blocks.1.attn.to_q.weight', rowStart: 0, rows: 4 },
    { key: 'transformer_blocks.1.attn.to_k.weight', rowStart: 4, rows: 4 },
    { key: 'transformer_blocks.1.attn.to_v.weight', rowStart: 8, rows: 4 },
  ]);
  assert.deepEqual(targetsFor('single_blocks.0.linear2', 3, base), [{ key: 'single_transformer_blocks.0.attn.to_out.weight', rowStart: 0, rows: 3 }]);
  assert.equal(targetsFor('double_blocks.1.img_attn.qkv', 9, base), null, 'wrong size');
  assert.equal(targetsFor('double_blocks.7.img_attn.qkv', 12, base), null, 'missing layer');
});

test('LoRA scale can be given after the file name', () => {
  assert.deepEqual(parseLoraArg('style.safetensors'), { ref: 'style.safetensors', scale: 1 });
  assert.deepEqual(parseLoraArg('style.safetensors:0.75'), { ref: 'style.safetensors', scale: 0.75 });
  assert.deepEqual(parseLoraArg('owner/name:-0.5'), { ref: 'owner/name', scale: -0.5 });
  assert.throws(() => parseLoraArg('x.safetensors:9'));
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'imagine-lora-'));
  const src = join(dir, 'model');
  mkdirSync(join(src, 'transformer'), { recursive: true });
  mkdirSync(join(src, 'vae'));
  writeFileSync(join(src, 'model_index.json'), '{}');
  writeFileSync(join(src, 'transformer', 'config.json'), '{}');
  // Three 4×3 projections and one untouched layer, in BF16 like the real model.
  const w = (seed: number) => range(12, (i) => ((i * 7 + seed) % 11) / 8 - 0.5);
  writeSafetensors(join(src, 'transformer', 'diffusion_pytorch_model.safetensors'), {
    'transformer_blocks.0.attn.to_q.weight': ['BF16', [4, 3], w(1)],
    'transformer_blocks.0.attn.to_k.weight': ['BF16', [4, 3], w(2)],
    'transformer_blocks.0.attn.to_v.weight': ['BF16', [4, 3], w(3)],
    'x_embedder.weight': ['BF16', [4, 3], w(4)],
  });
  return { dir, src, w };
}

test('merges an ai-toolkit LoRA onto the right rows, with alpha and scale', async () => {
  const { dir, src, w } = fixture();
  const rank = 2;
  const up = range(12 * rank, (i) => ((i % 5) - 2) / 4); // [12 × 2]: q, k, v stacked
  const down = range(rank * 3, (i) => ((i % 3) - 1) / 2); // [2 × 3]
  const lora = join(dir, 'lora.safetensors');
  writeSafetensors(lora, {
    'diffusion_model.double_blocks.0.img_attn.qkv.lora_A.weight': ['F32', [rank, 3], down],
    'diffusion_model.double_blocks.0.img_attn.qkv.lora_B.weight': ['F32', [12, rank], up],
    'diffusion_model.double_blocks.0.img_attn.qkv.alpha': ['F32', [], [1]], // alpha/rank = 0.5
  });

  const out = join(dir, 'merged');
  assert.deepEqual(await mergeLoras(src, [{ file: lora, scale: 2 }], out), { layers: 3 });

  const shard = join(out, 'transformer', 'diffusion_pytorch_model.safetensors');
  ['to_q', 'to_k', 'to_v'].forEach((name, t) => {
    const merged = readTensor(shard, `transformer_blocks.0.attn.${name}.weight`);
    const original = decodeTensor(encodeTensor(Float32Array.from(w(t + 1)), 'BF16'), 'BF16');
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 3; c++) {
        let delta = 0;
        for (let k = 0; k < rank; k++) delta += up[(t * 4 + r) * rank + k]! * down[k * 3 + c]!;
        const expected = original[r * 3 + c]! + 2 * 0.5 * delta;
        assert.ok(Math.abs(merged[r * 3 + c]! - expected) < 0.02, `${name}[${r},${c}] ${merged[r * 3 + c]} vs ${expected}`);
      }
    }
  });
  assert.deepEqual(readTensor(shard, 'x_embedder.weight'), decodeTensor(encodeTensor(Float32Array.from(w(4)), 'BF16'), 'BF16'));
  assert.ok(lstatSync(join(out, 'vae')).isSymbolicLink() && lstatSync(join(out, 'model_index.json')).isSymbolicLink());
  // The source model is never modified.
  assert.deepEqual(readTensor(join(src, 'transformer', 'diffusion_pytorch_model.safetensors'), 'transformer_blocks.0.attn.to_q.weight'), decodeTensor(encodeTensor(Float32Array.from(w(1)), 'BF16'), 'BF16'));
});

test('refuses a LoRA made for a different model, before writing anything', async () => {
  const { dir, src } = fixture();
  const lora = join(dir, 'other.safetensors');
  writeSafetensors(lora, {
    'transformer.transformer_blocks.9.attn.to_q.lora_A.weight': ['F32', [1, 3], [1, 1, 1]],
    'transformer.transformer_blocks.9.attn.to_q.lora_B.weight': ['F32', [4, 1], [1, 1, 1, 1]],
  });
  const out = join(dir, 'merged');
  await assert.rejects(mergeLoras(src, [{ file: lora, scale: 1 }], out), /1 of 1 layers .* don't match this model/);
  assert.equal(existsSync(out), false);
});
