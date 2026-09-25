/** `imagine create`: import a diffusers image model with imagine-engine, optionally quantizing it. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ENGINE_BIN, HF_CACHE_DIR, QUANTIZE_FORMATS } from './config.ts';
import { downloadHfSnapshot, listHfFiles, parseHfRepo, type HfProgress } from './huggingface.ts';
import { engineEnv, installEngine, type RuntimeEvents } from './runtime.ts';

export type QuantizeFormat = (typeof QUANTIZE_FORMATS)[number]['name'];

export function parseQuantize(value: string): QuantizeFormat {
  const format = QUANTIZE_FORMATS.find((f) => f.name === value.toLowerCase());
  if (!format) {
    throw new Error(`Unknown --quantize "${value}". Use one of: ${QUANTIZE_FORMATS.map((f) => f.name).join(', ')}.`);
  }
  return format.name;
}

export function isDiffusersDir(dir: string): boolean {
  return existsSync(join(dir, 'model_index.json'));
}

/**
 * A local diffusers folder is used in place. Anything else is treated as a Hugging Face repo and
 * downloaded (resumably) into ~/.imagine/huggingface.
 */
export async function resolveSource(
  from: string,
  onProgress?: (progress: HfProgress) => void,
): Promise<{ dir: string; downloaded: boolean }> {
  const local = resolve(from.startsWith('~/') ? join(homedir(), from.slice(2)) : from);
  if (existsSync(local)) {
    if (!isDiffusersDir(local)) {
      throw new Error(`${from} has no model_index.json, so it isn't a diffusers image model folder.`);
    }
    return { dir: local, downloaded: false };
  }

  const ref = parseHfRepo(from);
  if (!ref) throw new Error(`${from} is neither a local folder nor a Hugging Face repo like owner/name.`);
  const dir = join(HF_CACHE_DIR, ...ref.repo.split('/'));
  await downloadHfSnapshot({ repo: ref.repo, revision: ref.revision, dest: dir, onProgress });
  if (!isDiffusersDir(dir)) throw new Error(`${ref.repo} is not a diffusers image model (no model_index.json).`);
  return { dir, downloaded: true };
}

/** Import into the shared model store, where the engine and your Ollama both see it. No server needed. */
export async function createModel(
  name: string,
  dir: string,
  quantize: QuantizeFormat | undefined,
  events: RuntimeEvents = {},
): Promise<void> {
  await installEngine(events);
  const args = ['create', name, '--experimental'];
  if (quantize) args.push('--quantize', quantize);
  await new Promise<void>((done, fail) => {
    const child = spawn(ENGINE_BIN, args, { cwd: dir, stdio: 'inherit', env: engineEnv() });
    child.once('error', fail);
    child.once('exit', (code) => (code === 0 ? done() : fail(new Error(`Creating ${name} failed (exit ${code}).`))));
  });
}

/**
 * A LoRA from a local file, or from Hugging Face as owner/name (the repo's only .safetensors file)
 * or owner/name/path/file.safetensors. Downloads land in ~/.imagine/huggingface.
 */
export async function resolveLora(ref: string, onProgress?: (progress: HfProgress) => void): Promise<string> {
  const local = resolve(ref.startsWith('~/') ? join(homedir(), ref.slice(2)) : ref);
  if (existsSync(local)) return local;

  const [owner, name, ...rest] = ref.replace(/^hf:/, '').split('/');
  if (!owner || !name || !parseHfRepo(`${owner}/${name}`)) throw new Error(`LoRA not found: ${ref}`);
  const repo = `${owner}/${name}`;
  let file = rest.join('/');
  if (!file) {
    const candidates = (await listHfFiles(repo)).filter((f) => f.path.endsWith('.safetensors'));
    if (candidates.length !== 1) {
      throw new Error(
        candidates.length
          ? `${repo} has ${candidates.length} LoRA files. Name one, for example: ${repo}/${candidates[0]!.path}`
          : `${repo} has no .safetensors file.`,
      );
    }
    file = candidates[0]!.path;
  }
  const dest = join(HF_CACHE_DIR, owner, name);
  await downloadHfSnapshot({ repo, dest, include: (path) => path === file, onProgress });
  return join(dest, file);
}
