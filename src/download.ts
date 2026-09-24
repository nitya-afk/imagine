/**
 * Download a large file over a flaky connection: a connection that stalls or crawls is dropped and
 * the download resumes where it stopped (HTTP Range), even across runs, and the result is checked
 * against a SHA-256 before anything is installed.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { finished } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DownloadOptions {
  onProgress?: (received: number, total: number) => void;
  /** A connection that delivers less than `stallMinBytes` in this window is replaced. */
  stallWindowMs?: number;
  stallMinBytes?: number;
  /** Consecutive attempts without any progress before giving up. */
  maxAttempts?: number;
  retryDelayMs?: number;
}

class PermanentError extends Error {}

export async function downloadFile(url: string, file: string, options: DownloadOptions = {}): Promise<void> {
  const {
    onProgress,
    stallWindowMs = 20_000,
    stallMinBytes = 256 * 1024,
    maxAttempts = 8,
    retryDelayMs = 1000,
  } = options;
  // A partial file from an earlier run is resumed, not thrown away.
  let received = existsSync(file) ? statSync(file).size : 0;
  let total = 0;
  let failures = 0;

  for (;;) {
    const before = received;
    const controller = new AbortController();
    let windowStart = Date.now();
    let windowBytes = 0;
    const watchdog = setInterval(() => {
      if (Date.now() - windowStart < stallWindowMs) return;
      if (windowBytes < stallMinBytes) controller.abort();
      windowStart = Date.now();
      windowBytes = 0;
    }, Math.min(1000, stallWindowMs / 4));

    try {
      const res = await fetch(url, {
        headers: received > 0 ? { range: `bytes=${received}-` } : undefined,
        signal: controller.signal,
      });
      if (res.status === 416) {
        // The partial file doesn't fit what the server has now: start again from scratch.
        await res.body?.cancel();
        received = 0;
        continue;
      }
      if (!res.ok || !res.body) {
        const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        const message = `HTTP ${res.status}`;
        throw retryable ? new Error(message) : new PermanentError(message);
      }

      // 206 continues the partial file; a 200 means the server ignored Range, so start over.
      const resumed = received > 0 && res.status === 206;
      const length = Number(res.headers.get('content-length') ?? 0);
      if (!resumed) received = 0;
      total = resumed ? received + length : length;

      const out = createWriteStream(file, { flags: resumed ? 'a' : 'w' });
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          received += chunk.length;
          windowBytes += chunk.length;
          if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
          onProgress?.(received, total);
        }
      } finally {
        out.end();
        await finished(out);
      }
      if (total > 0 && received !== total) throw new Error(`the connection closed early (${received} of ${total} bytes)`);
      return;
    } catch (err) {
      if (err instanceof PermanentError) throw new Error(`Could not download ${url} (${err.message}).`);
      // Only attempts that got nothing count towards giving up; a slow line that keeps moving is fine.
      failures = received > before ? 0 : failures + 1;
      if (failures >= maxAttempts) {
        throw new Error(`Could not download ${url} (${describe(err)}). Run the command again to resume.`);
      }
      await sleep(retryDelayMs * failures || retryDelayMs);
    } finally {
      clearInterval(watchdog);
    }
  }
}

/** "fetch failed" hides the reason in `cause`; surface it. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'AbortError') return 'the connection stalled';
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? err.message;
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Download and verify. A file that already has the right checksum isn't downloaded again. */
export async function downloadVerified(
  url: string,
  file: string,
  sha256: string,
  options: DownloadOptions = {},
): Promise<void> {
  if (existsSync(file) && (await sha256File(file)) === sha256) return;
  await downloadFile(url, file, options);
  const digest = await sha256File(file);
  if (digest !== sha256) {
    rmSync(file, { force: true });
    throw new Error(`Checksum mismatch for ${url} (got ${digest}). Nothing was installed.`);
  }
}

/**
 * Download a verified .tar.gz and unpack it to `dest`, taking `root` (a folder inside the archive)
 * when given. The download survives interruptions; `dest` only appears once everything is in place.
 */
export async function installArchive(opts: {
  url: string;
  sha256: string;
  dest: string;
  root?: string;
  onProgress?: (received: number, total: number) => void;
}): Promise<void> {
  const staging = `${opts.dest}.partial`;
  mkdirSync(staging, { recursive: true });
  const archive = join(staging, 'download.tar.gz');
  await downloadVerified(opts.url, archive, opts.sha256, { onProgress: opts.onProgress });

  const unpacked = join(staging, 'unpacked');
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked);
  await execFileAsync('tar', ['-xzf', archive, '-C', unpacked]);

  rmSync(opts.dest, { recursive: true, force: true });
  mkdirSync(dirname(opts.dest), { recursive: true });
  renameSync(opts.root ? join(unpacked, opts.root) : unpacked, opts.dest);
  rmSync(staging, { recursive: true, force: true });
}
