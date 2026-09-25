import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * imagine-engine: Ollama 0.32.5 (the last release with image generation) built from source with
 * the patches in engine/patches, attached to this repo's GitHub release. engine/build.sh reproduces it.
 */
export const ENGINE_VERSION = '0.32.5-imagine.2';
/** The GitHub release that carries this engine build. */
const ENGINE_RELEASE = 'v1.3.0';
export const ENGINE_URL =
  process.env.IMAGINE_ENGINE_URL ??
  `https://github.com/nitya-afk/imagine/releases/download/${ENGINE_RELEASE}/imagine-engine-${ENGINE_VERSION}-darwin-arm64.tar.gz`;
export const ENGINE_SHA256 =
  process.env.IMAGINE_ENGINE_SHA256 ?? 'fd311e71150a5fea6dc41a30fd4615109a60c95da418efd061cd1203ecfd0528';

export const DEFAULT_MODEL = process.env.IMAGINE_MODEL ?? 'x/flux2-klein';
export const DEFAULT_SIZE = '1024x1024';
export const DEFAULT_SERVE_PORT = 11436;

export const IMAGINE_HOME = process.env.IMAGINE_HOME ?? join(homedir(), '.imagine');
export const ENGINE_DIR = join(IMAGINE_HOME, 'engine', ENGINE_VERSION);
export const ENGINE_BIN = join(ENGINE_DIR, 'imagine-engine');
export const ENGINE_PORT = Number(process.env.IMAGINE_ENGINE_PORT ?? 11435);
export const PID_FILE = join(IMAGINE_HOME, 'engine.pid');
export const LOG_FILE = join(IMAGINE_HOME, 'engine.log');
export const STATE_FILE = join(IMAGINE_HOME, 'state.json');
export const HF_CACHE_DIR = join(IMAGINE_HOME, 'huggingface');

export const OUTPUT_DIR = process.env.IMAGINE_OUTPUT_DIR ?? join(homedir(), 'Pictures', 'imagine');

export interface KnownModel {
  name: string;
  /** Download size in bytes, from the registry manifest. */
  size: number;
  license: string;
  edits: boolean;
}

/** Image models in the Ollama library. `latest` tags are aliases of the smallest variant. */
export const KNOWN_MODELS: readonly KnownModel[] = [
  { name: 'x/flux2-klein:4b-fp4', size: 5.73e9, license: 'Apache-2.0', edits: true },
  { name: 'x/flux2-klein:4b-fp8', size: 9.45e9, license: 'Apache-2.0', edits: true },
  { name: 'x/flux2-klein:4b-bf16', size: 15.98e9, license: 'Apache-2.0', edits: true },
  { name: 'x/flux2-klein:9b-fp4', size: 11.97e9, license: 'non-commercial', edits: true },
  { name: 'x/flux2-klein:9b-fp8', size: 20.24e9, license: 'non-commercial', edits: true },
  { name: 'x/flux2-klein:9b-bf16', size: 34.72e9, license: 'non-commercial', edits: true },
  { name: 'x/z-image-turbo:fp8', size: 12.77e9, license: 'Apache-2.0', edits: false },
  { name: 'x/z-image-turbo:bf16', size: 32.85e9, license: 'Apache-2.0', edits: false },
];

/**
 * Formats `imagine create --quantize` writes, best first. All five run with MLX's native quantized
 * matmul, so weights stay small in memory too. Measured on FLUX.2 Klein 4B, M5 Pro, 768×768.
 */
export const QUANTIZE_FORMATS = [
  { name: 'mxfp8', bits: 8, note: 'best quality, closest to full precision (8.8 GB, 10.7 s)' },
  { name: 'mxfp4', bits: 4, note: 'smallest and fastest (5.0 GB, 10.0 s)' },
  { name: 'int8', bits: 8, note: 'near-lossless integer (9.0 GB, 12.1 s)' },
  { name: 'int4', bits: 4, note: '4-bit integer (5.3 GB, 12.8 s)' },
  { name: 'nvfp4', bits: 4, note: '4-bit float, drifts most from full precision (5.3 GB, 10.3 s)' },
] as const;
