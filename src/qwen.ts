/** Qwen-Image 2.1 GGUF support through stable-diffusion.cpp's Metal backend. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QWEN_DIR,
  QWEN_FILES,
  QWEN_MODEL,
  QWEN_REPO,
  QWEN_TEXT_REPO,
  SD_CPP_BIN,
  SD_CPP_DIR,
  SD_CPP_SHA256,
  SD_CPP_URL,
} from './config.ts';
import { installArchive } from './download.ts';
import { downloadHfSnapshot, type HfProgress } from './huggingface.ts';
import { canonicalModel } from './models.ts';
import type { GenerateParams, StepProgress } from './ollama.ts';
import { pngSize } from './png.ts';
import type { RuntimeEvents } from './runtime.ts';

export function isQwenModel(name: string): boolean {
  return canonicalModel(name) === QWEN_MODEL;
}

export function isQwenInstalled(): boolean {
  return Object.values(QWEN_FILES).every((file) => existsSync(join(QWEN_DIR, file)));
}

export function isSdCppInstalled(): boolean {
  return existsSync(SD_CPP_BIN);
}

export async function installSdCpp(events: RuntimeEvents = {}): Promise<void> {
  if (isSdCppInstalled()) return;
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('The bundled Qwen backend needs a Mac with Apple silicon.');
  }
  events.onStatus?.('Downloading the Qwen Metal runtime (one time, 35 MB)…');
  await installArchive({
    url: SD_CPP_URL,
    sha256: SD_CPP_SHA256,
    dest: SD_CPP_DIR,
    onProgress: events.onDownload,
  });
}

export async function pullQwenModel(
  onProgress?: (progress: HfProgress) => void,
  events: RuntimeEvents = {},
): Promise<void> {
  await installSdCpp(events);
  const modelFiles = new Set<string>([QWEN_FILES.diffusion, QWEN_FILES.vae]);
  await downloadHfSnapshot({ repo: QWEN_REPO, dest: QWEN_DIR, include: (path) => modelFiles.has(path), onProgress });
  const textFiles = new Set<string>([QWEN_FILES.textEncoder, QWEN_FILES.vision]);
  await downloadHfSnapshot({ repo: QWEN_TEXT_REPO, dest: QWEN_DIR, include: (path) => textFiles.has(path), onProgress });
}

export function qwenArgs(params: GenerateParams, output: string, references: string[] = []): string[] {
  let width = params.width;
  let height = params.height;
  if ((!width || !height) && params.images?.[0]) {
    const size = pngSize(Buffer.from(params.images[0], 'base64'));
    width ??= size?.width;
    height ??= size?.height;
  }
  width ??= 1024;
  height ??= 1024;
  if (width % 32 || height % 32) {
    throw new Error(`Qwen-Image 2.1 needs width and height divisible by 32 (got ${width}x${height}).`);
  }

  const args = [
    '--diffusion-model', join(QWEN_DIR, QWEN_FILES.diffusion),
    '--llm', join(QWEN_DIR, QWEN_FILES.textEncoder),
    '--llm_vision', join(QWEN_DIR, QWEN_FILES.vision),
    '--vae', join(QWEN_DIR, QWEN_FILES.vae),
    '--prompt', params.prompt,
    '--negative-prompt',
    'CGI, 3D render, illustration, painting, anime, doll, mannequin, waxy skin, plastic skin, airbrushed, excessive symmetry, beauty filter, oversaturated, glossy, malformed anatomy, extra fingers, fused fingers, duplicated limbs, distorted hands, distorted feet, impossible pose',
    '--width', String(width),
    '--height', String(height),
    '--steps', String(params.steps ?? 25),
    '--seed', String(params.seed),
    '--cfg-scale', '6.0',
    '--sampling-method', 'euler',
    '--fa',
    '--model-args', 'qwen_image_2_1_prefix_cache_type=q8_0',
  ];
  // Interactive modes reuse transformer work on stable-diffusion.cpp's documented SCM schedule.
  // Quality mode stays exact. The mask must match the requested number of sampling steps.
  if (params.cache) {
    const steps = params.steps ?? 25;
    const scmMask = steps === 20
      ? '1,1,1,1,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,1'
      : '1,1,1,1,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,1,1';
    args.push(
      '--cache-mode', 'cache-dit',
      '--cache-option', 'Fn=8,Bn=0,threshold=0.08,warmup=4',
      '--scm-mask', scmMask,
      '--scm-policy', 'static',
    );
  }
  args.push('--output', output);
  for (const file of references) args.push('--ref-image', file);
  return args;
}

export async function generateQwenImage(
  params: GenerateParams,
  onProgress?: (progress: StepProgress) => void,
): Promise<Buffer> {
  if (!isQwenInstalled()) {
    throw new Error(`Model ${QWEN_MODEL} is not installed. Download it with: imagine pull ${QWEN_MODEL}`);
  }
  if (!isSdCppInstalled()) {
    throw new Error('The Qwen runtime is not installed. Run `imagine pull qwen-image-2.1-uncensored`.');
  }

  const dir = await mkdtemp(join(tmpdir(), 'imagine-qwen-'));
  try {
    const output = join(dir, 'output.png');
    const references: string[] = [];
    for (const [index, image] of (params.images ?? []).entries()) {
      const file = join(dir, `reference-${index + 1}.png`);
      await writeFile(file, Buffer.from(image, 'base64'));
      references.push(file);
    }
    await runSdCpp(qwenArgs(params, output, references), params.steps ?? 25, onProgress);
    if (!existsSync(output)) throw new Error('The Qwen backend finished without producing an image.');
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runSdCpp(args: string[], total: number, onProgress?: (progress: StepProgress) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(SD_CPP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    const consume = (chunk: Buffer) => {
      const text = chunk.toString();
      diagnostics = (diagnostics + text).slice(-12_000);
      for (const match of text.matchAll(/(?:^|\s)(\d+)\s*\/\s*(\d+)(?:\s|$)/g)) {
        const completed = Number(match[1]);
        const reportedTotal = Number(match[2]);
        if (reportedTotal > 0) onProgress?.({ completed, total: reportedTotal });
      }
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        onProgress?.({ completed: total, total });
        resolve();
      } else {
        const reason = diagnostics.trim().split('\n').slice(-8).join('\n');
        reject(new Error(`Qwen generation failed (${signal ?? `exit ${code ?? 'unknown'}`}).${reason ? `\n${reason}` : ''}`));
      }
    });
  });
}
