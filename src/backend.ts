/**
 * Decides which Ollama-compatible server runs a request.
 *
 * 1. IMAGINE_OLLAMA_HOST, if set, is always used as-is.
 * 2. Edits always go to imagine-engine, the only build known to use input images.
 * 3. Otherwise your normal Ollama is tried first. If it answers "image generation models are not
 *    currently supported", that version is remembered and never tried again. A future Ollama that
 *    brings image generation back has a new version number, so it gets tried automatically.
 * 4. Otherwise imagine-engine is started and used.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { STATE_FILE } from './config.ts';
import { normalizeHost } from './host.ts';
import { getVersion, isImageGenUnsupported } from './ollama.ts';
import { startEngine, type RuntimeEvents } from './runtime.ts';

export interface BackendDeps {
  overrideHost?: string;
  mainHost: string;
  getVersion: (host: string) => Promise<string | null>;
  startEngine: () => Promise<string>;
  isUnsupported: (version: string) => boolean;
  markUnsupported: (version: string) => void;
}

export function defaultDeps(events: RuntimeEvents = {}): BackendDeps {
  const override = process.env.IMAGINE_OLLAMA_HOST;
  return {
    overrideHost: override ? normalizeHost(override) : undefined,
    mainHost: normalizeHost(process.env.OLLAMA_HOST),
    getVersion: (host) => getVersion(host),
    startEngine: () => startEngine(events),
    isUnsupported: (version) => readState().unsupportedVersions.includes(version),
    markUnsupported: (version) => {
      const state = readState();
      if (!state.unsupportedVersions.includes(version)) {
        state.unsupportedVersions.push(version);
        writeState(state);
      }
    },
  };
}

/** Run an image request, falling back to imagine-engine when the main Ollama can't do images. */
export async function withImageBackend<T>(
  fn: (host: string) => Promise<T>,
  deps: BackendDeps,
  options: { editing?: boolean } = {},
): Promise<T> {
  if (deps.overrideHost) return fn(deps.overrideHost);
  if (options.editing) return fn(await deps.startEngine());

  const mainVersion = await deps.getVersion(deps.mainHost);
  if (mainVersion && !deps.isUnsupported(mainVersion)) {
    try {
      return await fn(deps.mainHost);
    } catch (err) {
      if (!isImageGenUnsupported(err)) throw err;
      deps.markUnsupported(mainVersion);
    }
  }
  return fn(await deps.startEngine());
}

/** The server to use for model listing and pulls, without trying a generation first. */
export async function resolveImageHost(deps: BackendDeps): Promise<string> {
  if (deps.overrideHost) return deps.overrideHost;
  const mainVersion = await deps.getVersion(deps.mainHost);
  if (mainVersion && !deps.isUnsupported(mainVersion)) return deps.mainHost;
  return deps.startEngine();
}

interface State {
  unsupportedVersions: string[];
}

function readState(): State {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<State>;
    return { unsupportedVersions: Array.isArray(raw.unsupportedVersions) ? raw.unsupportedVersions : [] };
  } catch {
    return { unsupportedVersions: [] };
  }
}

function writeState(state: State): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}
