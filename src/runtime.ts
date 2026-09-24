/**
 * Manages imagine-engine: installs it once into ~/.imagine, runs it on a side port, and stops it.
 * It shares ~/.ollama/models with your normal Ollama, so models are never downloaded twice.
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  ENGINE_BIN,
  ENGINE_DIR,
  ENGINE_PORT,
  ENGINE_SHA256,
  ENGINE_URL,
  ENGINE_VERSION,
  IMAGINE_HOME,
  LOG_FILE,
  PID_FILE,
} from './config.ts';
import { installArchive } from './download.ts';
import { getVersion } from './ollama.ts';

const execFileAsync = promisify(execFile);

export interface RuntimeEvents {
  onStatus?: (message: string) => void;
  onDownload?: (received: number, total: number) => void;
}

export function engineHost(): string {
  return `http://127.0.0.1:${ENGINE_PORT}`;
}

export function isEngineInstalled(): boolean {
  return existsSync(ENGINE_BIN);
}

export function assertSupportedPlatform(): void {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('imagine needs a Mac with Apple silicon (M1 or newer).');
  }
}

/** Download, verify and unpack the engine. Safe to interrupt: it only lands once complete. */
export async function installEngine(events: RuntimeEvents = {}): Promise<void> {
  if (isEngineInstalled()) return;
  assertSupportedPlatform();
  events.onStatus?.('Downloading the image engine (one time, 115 MB)…');
  await installArchive({
    url: ENGINE_URL,
    sha256: ENGINE_SHA256,
    dest: ENGINE_DIR,
    root: 'imagine-engine',
    onProgress: events.onDownload,
  });

  // Earlier engine versions are dead weight once the new one is in place.
  const engines = dirname(ENGINE_DIR);
  for (const entry of readdirSync(engines)) {
    if (entry !== basename(ENGINE_DIR)) rmSync(join(engines, entry), { recursive: true, force: true });
  }
}

/** Environment for engine processes: its own port, quiet HTTP logs, the shared model store. */
export function engineEnv(): NodeJS.ProcessEnv {
  return { ...process.env, OLLAMA_HOST: `127.0.0.1:${ENGINE_PORT}`, GIN_MODE: 'release' };
}

/** Start the engine if it isn't already up, and return its base URL. */
export async function startEngine(events: RuntimeEvents = {}): Promise<string> {
  const host = engineHost();
  const running = await getVersion(host);
  if (running === ENGINE_VERSION) return host;
  if (running) {
    // An older imagine-engine that we started is replaced; anything else on the port is left alone.
    if (!running.includes('-imagine.') || (await stopEngine()) !== 'stopped') {
      throw new Error(
        `Port ${ENGINE_PORT} is already used by Ollama ${running}. Stop it, or set IMAGINE_ENGINE_PORT to a free port.`,
      );
    }
    events.onStatus?.(`Updating the image engine from ${running} to ${ENGINE_VERSION}…`);
    for (let i = 0; i < 50 && (await getVersion(host, 500)); i++) await sleep(200);
  }

  await installEngine(events);

  events.onStatus?.('Starting the image engine…');
  mkdirSync(IMAGINE_HOME, { recursive: true });
  const log = openSync(LOG_FILE, 'a');
  const child = spawn(ENGINE_BIN, ['serve'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: engineEnv(),
  });
  closeSync(log);
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  child.unref();
  if (child.pid) writeFileSync(PID_FILE, String(child.pid));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !exited) {
    if ((await getVersion(host, 1000)) === ENGINE_VERSION) return host;
    await sleep(300);
  }
  throw new Error(`The image engine did not start. Its log is at ${LOG_FILE}`);
}

export type StopResult = 'stopped' | 'not-running' | 'not-ours';

export async function stopEngine(): Promise<StopResult> {
  const pid = readPid();
  rmSync(PID_FILE, { force: true });
  if (pid && (await isEngineProcess(pid))) {
    process.kill(pid, 'SIGTERM');
    return 'stopped';
  }
  // Something is answering on the port, but we didn't start it, so leave it alone.
  return (await getVersion(engineHost())) ? 'not-ours' : 'not-running';
}

function readPid(): number | null {
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Any version of imagine-engine under ~/.imagine/engine, so an older one can be replaced. */
async function isEngineProcess(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)]);
    return stdout.includes(`${dirname(ENGINE_DIR)}/`) && stdout.includes('imagine-engine');
  } catch {
    return false;
  }
}
