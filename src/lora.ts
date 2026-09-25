/**
 * `imagine create --lora`: bake LoRAs into a model's weights before it's imported, so they work with
 * every quantization format and cost nothing per image.
 *
 * Reads diffusers/PEFT LoRAs (`transformer.…to_q.lora_A.weight`) and ai-toolkit/BFL ones
 * (`diffusion_model.double_blocks.N.img_attn.qkv.lora_A.weight`), whose fused layers are split onto
 * the diffusers layers they correspond to.
 */
import {
  closeSync,
  constants,
  copyFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

interface TensorInfo {
  dtype: string;
  shape: number[];
  /** Absolute byte offsets in the file. */
  start: number;
  end: number;
}

export function readSafetensorsHeader(path: string): Map<string, TensorInfo> {
  const fd = openSync(path, 'r');
  try {
    const lengthBytes = Buffer.alloc(8);
    readSync(fd, lengthBytes, 0, 8, 0);
    const length = Number(lengthBytes.readBigUInt64LE());
    const header = Buffer.alloc(length);
    readSync(fd, header, 0, length, 8);
    const json = JSON.parse(header.toString('utf8')) as Record<
      string,
      { dtype: string; shape: number[]; data_offsets: [number, number] }
    >;
    const tensors = new Map<string, TensorInfo>();
    for (const [name, t] of Object.entries(json)) {
      if (name === '__metadata__') continue;
      tensors.set(name, { dtype: t.dtype, shape: t.shape, start: 8 + length + t.data_offsets[0], end: 8 + length + t.data_offsets[1] });
    }
    return tensors;
  } finally {
    closeSync(fd);
  }
}

function readBytes(path: string, t: TensorInfo): Buffer {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(t.end - t.start);
    readSync(fd, bytes, 0, bytes.length, t.start);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function halfToFloat(h: number): number {
  const exponent = (h >> 10) & 0x1f;
  const mantissa = h & 0x3ff;
  const sign = h & 0x8000 ? -1 : 1;
  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 31) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

function floatToHalf(value: number): number {
  f32[0] = value;
  const x = u32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exponent = ((x >>> 23) & 0xff) - 127 + 15;
  const mantissa = x & 0x7fffff;
  if (exponent >= 31) return sign | 0x7c00;
  if (exponent <= 0) return exponent < -10 ? sign : sign | ((mantissa | 0x800000) >> (14 - exponent));
  return sign | (exponent << 10) | (mantissa >> 13);
}

export function decodeTensor(bytes: Buffer, dtype: string): Float32Array {
  const count = dtype === 'F32' ? bytes.length / 4 : bytes.length / 2;
  const out = new Float32Array(count);
  if (dtype === 'F32') {
    for (let i = 0; i < count; i++) out[i] = bytes.readFloatLE(i * 4);
  } else if (dtype === 'BF16') {
    const bits = new Uint32Array(out.buffer);
    for (let i = 0; i < count; i++) bits[i] = bytes.readUInt16LE(i * 2) << 16;
  } else if (dtype === 'F16') {
    for (let i = 0; i < count; i++) out[i] = halfToFloat(bytes.readUInt16LE(i * 2));
  } else {
    throw new Error(`Unsupported tensor type ${dtype}.`);
  }
  return out;
}

export function encodeTensor(values: Float32Array, dtype: string): Buffer {
  const out = Buffer.alloc(values.length * (dtype === 'F32' ? 4 : 2));
  if (dtype === 'F32') {
    for (let i = 0; i < values.length; i++) out.writeFloatLE(values[i]!, i * 4);
  } else if (dtype === 'BF16') {
    const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
    for (let i = 0; i < values.length; i++) {
      const x = bits[i]!;
      // Round to nearest even; NaN stays NaN.
      const rounded = (x & 0x7fffffff) > 0x7f800000 ? (x >>> 16) | 0x40 : (x + 0x7fff + ((x >>> 16) & 1)) >>> 16;
      out.writeUInt16LE(rounded & 0xffff, i * 2);
    }
  } else if (dtype === 'F16') {
    for (let i = 0; i < values.length; i++) out.writeUInt16LE(floatToHalf(values[i]!), i * 2);
  } else {
    throw new Error(`Unsupported tensor type ${dtype}.`);
  }
  return out;
}

const PREFIXES = ['model.diffusion_model.', 'diffusion_model.', 'base_model.model.', 'transformer.'];

export interface LoraModule {
  name: string;
  down: string;
  up: string;
  alpha?: string;
}

/** Pair each layer's down/up matrices (and optional alpha) under its normalized module name. */
export function loraModules(keys: Iterable<string>): { modules: LoraModule[]; ignored: string[] } {
  const found = new Map<string, Partial<LoraModule>>();
  const ignored: string[] = [];
  for (const key of keys) {
    let name = key;
    for (const prefix of PREFIXES) if (name.startsWith(prefix)) name = name.slice(prefix.length);
    const match = /^(.*)\.(lora_A|lora_down|lora_B|lora_up)\.weight$/.exec(name) ?? /^(.*)\.(alpha)$/.exec(name);
    if (!match) {
      ignored.push(key);
      continue;
    }
    const entry = found.get(match[1]!) ?? { name: match[1]! };
    if (match[2] === 'lora_A' || match[2] === 'lora_down') entry.down = key;
    else if (match[2] === 'alpha') entry.alpha = key;
    else entry.up = key;
    found.set(match[1]!, entry);
  }
  const modules: LoraModule[] = [];
  for (const entry of found.values()) {
    if (entry.down && entry.up) modules.push(entry as LoraModule);
    else ignored.push(entry.name!);
  }
  return { modules, ignored };
}

export interface Target {
  key: string;
  /** Rows of the LoRA's up matrix that belong to this layer (for fused layers). */
  rowStart: number;
  rows: number;
}

/** BFL layer names (ai-toolkit, ComfyUI) → diffusers FLUX.2 layers. Fused qkv splits three ways. */
const BFL_MAP: Array<[RegExp, (i: string) => string[]]> = [
  [/^double_blocks\.(\d+)\.img_attn\.qkv$/, (i) => ['to_q', 'to_k', 'to_v'].map((p) => `transformer_blocks.${i}.attn.${p}`)],
  [/^double_blocks\.(\d+)\.txt_attn\.qkv$/, (i) => ['add_q_proj', 'add_k_proj', 'add_v_proj'].map((p) => `transformer_blocks.${i}.attn.${p}`)],
  [/^double_blocks\.(\d+)\.img_attn\.proj$/, (i) => [`transformer_blocks.${i}.attn.to_out.0`]],
  [/^double_blocks\.(\d+)\.txt_attn\.proj$/, (i) => [`transformer_blocks.${i}.attn.to_add_out`]],
  [/^double_blocks\.(\d+)\.img_mlp\.0$/, (i) => [`transformer_blocks.${i}.ff.linear_in`]],
  [/^double_blocks\.(\d+)\.img_mlp\.2$/, (i) => [`transformer_blocks.${i}.ff.linear_out`]],
  [/^double_blocks\.(\d+)\.txt_mlp\.0$/, (i) => [`transformer_blocks.${i}.ff_context.linear_in`]],
  [/^double_blocks\.(\d+)\.txt_mlp\.2$/, (i) => [`transformer_blocks.${i}.ff_context.linear_out`]],
  [/^single_blocks\.(\d+)\.linear1$/, (i) => [`single_transformer_blocks.${i}.attn.to_qkv_mlp_proj`]],
  [/^single_blocks\.(\d+)\.linear2$/, (i) => [`single_transformer_blocks.${i}.attn.to_out`]],
];

/** Which model tensors a LoRA module updates, or null if it doesn't fit this model. */
export function targetsFor(module: string, upRows: number, base: Map<string, { shape: number[] }>): Target[] | null {
  if (base.has(`${module}.weight`)) return [{ key: `${module}.weight`, rowStart: 0, rows: upRows }];
  for (const [pattern, layers] of BFL_MAP) {
    const match = pattern.exec(module);
    if (!match) continue;
    const keys = layers(match[1]!).map((layer) => `${layer}.weight`);
    const rows = upRows / keys.length;
    if (!Number.isInteger(rows) || keys.some((k) => base.get(k)?.shape[0] !== rows)) return null;
    return keys.map((key, i) => ({ key, rowStart: i * rows, rows }));
  }
  return null;
}

/** weight[rows × cols] += scale · up[rowStart … rowStart+rows] · down[rank × cols], in place. */
export function addLowRank(
  weight: Float32Array,
  up: Float32Array,
  down: Float32Array,
  rank: number,
  target: Target,
  cols: number,
  scale: number,
): void {
  for (let i = 0; i < target.rows; i++) {
    const row = i * cols;
    const upRow = (target.rowStart + i) * rank;
    for (let k = 0; k < rank; k++) {
      const c = scale * up[upRow + k]!;
      if (c === 0) continue;
      const downRow = k * cols;
      for (let j = 0; j < cols; j++) weight[row + j]! += c * down[downRow + j]!;
    }
  }
}

export interface LoraSpec {
  file: string;
  scale: number;
}

/** "style.safetensors" or "style.safetensors:0.8". */
export function parseLoraArg(value: string): { ref: string; scale: number } {
  const match = /^(.*):(-?\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return { ref: value, scale: 1 };
  const scale = Number(match[2]);
  if (!Number.isFinite(scale) || Math.abs(scale) > 4) throw new Error(`LoRA scale must be between -4 and 4 (got ${match[2]}).`);
  return { ref: match[1]!, scale };
}

/**
 * Write a copy of the diffusers folder at `sourceDir` into `destDir` with the LoRAs merged into the
 * transformer. Untouched files are symlinked or cloned (free on APFS); only merged layers change.
 */
export async function mergeLoras(
  sourceDir: string,
  loras: LoraSpec[],
  destDir: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ layers: number }> {
  const transformerDir = join(sourceDir, 'transformer');
  const shards = readdirSync(transformerDir).filter((f) => f.endsWith('.safetensors'));
  const base = new Map<string, TensorInfo & { file: string }>();
  for (const shard of shards) {
    for (const [key, info] of readSafetensorsHeader(join(transformerDir, shard))) base.set(key, { ...info, file: shard });
  }

  // Plan every update first, so a LoRA that doesn't fit is refused before anything is written.
  const plan = new Map<string, Array<{ lora: LoraSpec; module: LoraModule; target: Target; scale: number; rank: number }>>();
  const headers = new Map(loras.map((lora) => [lora.file, readSafetensorsHeader(lora.file)]));
  for (const lora of loras) {
    const header = headers.get(lora.file)!;
    const { modules } = loraModules(header.keys());
    if (modules.length === 0) throw new Error(`${lora.file} has no LoRA layers (lora_A/lora_B or lora_down/lora_up).`);
    const unmatched: string[] = [];
    for (const module of modules) {
      const down = header.get(module.down)!;
      const up = header.get(module.up)!;
      const rank = down.shape[0]!;
      const targets = targetsFor(module.name, up.shape[0]!, base);
      const fits = (t: Target) => base.get(t.key)!.shape[0] === t.rows && base.get(t.key)!.shape[1] === down.shape[1];
      if (!targets || up.shape[1] !== rank || !targets.every(fits)) {
        unmatched.push(module.name);
        continue;
      }
      const alpha = module.alpha ? decodeTensor(readBytes(lora.file, header.get(module.alpha)!), header.get(module.alpha)!.dtype)[0]! : rank;
      for (const target of targets) {
        const updates = plan.get(target.key) ?? [];
        updates.push({ lora, module, target, scale: lora.scale * (alpha / rank), rank });
        plan.set(target.key, updates);
      }
    }
    if (unmatched.length) {
      throw new Error(
        `${unmatched.length} of ${modules.length} layers in ${lora.file} don't match this model ` +
          `(for example ${unmatched.slice(0, 3).join(', ')}). Is the LoRA made for this model?`,
      );
    }
  }

  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(join(destDir, 'transformer'), { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    if (entry !== 'transformer') symlinkSync(join(sourceDir, entry), join(destDir, entry));
  }
  for (const entry of readdirSync(transformerDir)) {
    const from = join(transformerDir, entry);
    const to = join(destDir, 'transformer', entry);
    if (entry.endsWith('.safetensors')) copyFileSync(from, to, constants.COPYFILE_FICLONE);
    else symlinkSync(from, to);
  }

  const tasks: MergeTask[] = [...plan].map(([key, updates]) => {
    const info = base.get(key)!;
    return {
      file: join(destDir, 'transformer', info.file),
      tensor: { start: info.start, end: info.end, dtype: info.dtype },
      cols: info.shape[1]!,
      updates: updates.map((u) => {
        const header = headers.get(u.lora.file)!;
        const pick = (name: string) => {
          const t = header.get(name)!;
          return { start: t.start, end: t.end, dtype: t.dtype };
        };
        return { file: u.lora.file, up: pick(u.module.up), down: pick(u.module.down), rank: u.rank, target: u.target, scale: u.scale };
      }),
    };
  });
  // Biggest layers first, spread over the CPU cores: each layer is independent.
  tasks.sort((a, b) => b.tensor.end - b.tensor.start - (a.tensor.end - a.tensor.start));
  await runTasks(tasks, onProgress);
  return { layers: plan.size };
}

interface ByteRange {
  start: number;
  end: number;
  dtype: string;
}

/** One layer to update: read it, add every LoRA's low-rank delta, write it back in place. */
interface MergeTask {
  file: string;
  tensor: ByteRange;
  cols: number;
  updates: Array<{ file: string; up: ByteRange; down: ByteRange; rank: number; target: Target; scale: number }>;
}

function applyTask(task: MergeTask): void {
  const read = (file: string, range: ByteRange) =>
    decodeTensor(readBytes(file, { dtype: range.dtype, shape: [], start: range.start, end: range.end }), range.dtype);
  const weight = read(task.file, task.tensor);
  for (const u of task.updates) {
    addLowRank(weight, read(u.file, u.up), read(u.file, u.down), u.rank, u.target, task.cols, u.scale);
  }
  const fd = openSync(task.file, 'r+');
  try {
    writeSync(fd, encodeTensor(weight, task.tensor.dtype), 0, task.tensor.end - task.tensor.start, task.tensor.start);
  } finally {
    closeSync(fd);
  }
}

/** Run tasks on worker threads (at most 6, so memory stays modest), or inline for tiny jobs. */
async function runTasks(tasks: MergeTask[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const size = Math.min(tasks.length, 6, Math.max(1, availableParallelism() - 1));
  let done = 0;
  if (size <= 1) {
    for (const task of tasks) {
      applyTask(task);
      onProgress?.(++done, tasks.length);
    }
    return;
  }
  let next = 0;
  const workers = Array.from({ length: size }, () => new Worker(new URL(import.meta.url), { workerData: { loraMerge: true } }));
  try {
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            const feed = () => {
              if (next >= tasks.length) return resolve();
              worker.postMessage(tasks[next++]);
            };
            worker.on('message', (message: { error?: string }) => {
              if (message.error) return reject(new Error(message.error));
              onProgress?.(++done, tasks.length);
              feed();
            });
            worker.once('error', reject);
            feed();
          }),
      ),
    );
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

if (!isMainThread && (workerData as { loraMerge?: boolean } | null)?.loraMerge) {
  parentPort!.on('message', (task: MergeTask) => {
    try {
      applyTask(task);
      parentPort!.postMessage({});
    } catch (err) {
      parentPort!.postMessage({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
