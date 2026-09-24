/**
 * Downloads Hugging Face model repos in the diffusers layout (model_index.json plus a folder per
 * component) without Python or git-lfs. Files arrive one at a time, and interrupted downloads resume.
 */
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';

export interface HfFile {
  path: string;
  size: number;
}

export interface HfProgress {
  /** Repo-relative path of the file being downloaded. */
  file: string;
  received: number;
  total: number;
  /** Bytes across all selected files, counting the ones that were already complete. */
  overallReceived: number;
  overallTotal: number;
}

export interface HfDownloadOptions {
  /** "owner/name". */
  repo: string;
  /** Local folder. Files keep their repo-relative paths inside it. */
  dest: string;
  /** Branch, tag or commit (default "main"). */
  revision?: string;
  /** Needed for gated and private models (default HF_TOKEN). */
  token?: string;
  /** Which repo files to download (default diffusersFilter). */
  include?: (path: string) => boolean;
  /** Default HF_ENDPOINT, then https://huggingface.co. */
  endpoint?: string;
  onProgress?: (p: HfProgress) => void;
}

const DEFAULT_ENDPOINT = 'https://huggingface.co';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 200;
const PROGRESS_INTERVAL_MS = 100;

const REPO_ID = /^\w(?:[\w.-]*\w)?\/\w(?:[\w.-]*\w)?$/;
const HF_URL = /^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\/([^?#]*)/i;
const ROOT_FILE = /\.json$/i;
const COMPONENT_FILE = /\.(?:json|txt|model|tiktoken|jinja|safetensors)$/i;

/** Network errors, 5xx and 429: worth another try. */
class RetryableError extends Error {}
/** The bytes don't add up to the listed size, so the partial file can't be trusted. */
class SizeMismatchError extends Error {}

/**
 * Parse "owner/name", "hf:owner/name" or "https://huggingface.co/owner/name[/tree/<rev>]". Returns
 * null if it isn't a repo reference. A bare "owner/name" is accepted even though Ollama model names
 * such as "x/flux2-klein" look the same, so callers decide which reading wins.
 */
export function parseHfRepo(ref: string): { repo: string; revision?: string } | null {
  const value = ref.trim();
  const url = HF_URL.exec(value);
  if (!url) {
    const repo = value.startsWith('hf:') ? value.slice('hf:'.length) : value;
    return REPO_ID.test(repo) ? { repo } : null;
  }
  const [owner = '', name = '', view = '', rev = ''] = (url[1] ?? '').split('/');
  const repo = `${owner}/${name}`;
  // Datasets and Spaces live under the same host but aren't models.
  if (owner === 'datasets' || owner === 'spaces' || !REPO_ID.test(repo)) return null;
  if (!rev || !['tree', 'blob', 'resolve'].includes(view)) return { repo };
  try {
    // Branches with slashes arrive encoded, like refs%2Fpr%2F3.
    return { repo, revision: decodeURIComponent(rev) };
  } catch {
    return null;
  }
}

/**
 * Keep what a diffusers pipeline needs; drop single-file checkpoints at the repo root, docs, images
 * and git files. Component folders keep configs, safetensors weights and tokenizer data (vocabularies,
 * merges, sentencepiece and tiktoken models, chat templates); other weight formats are dropped.
 */
export function diffusersFilter(path: string): boolean {
  const parts = path.split('/');
  if (parts.some((part) => part.startsWith('.'))) return false;
  return parts.length === 1 ? ROOT_FILE.test(path) : COMPONENT_FILE.test(path);
}

/** List a model repo's files and their sizes at a revision. */
export async function listHfFiles(
  repo: string,
  opts: { revision?: string; token?: string; endpoint?: string } = {},
): Promise<HfFile[]> {
  return listFiles(hubFor(repo, opts));
}

/**
 * Download the repo files that `include` selects into `dest`, one at a time. Complete files are
 * skipped and `.partial` leftovers are resumed, so running it again after an interruption is cheap.
 */
export async function downloadHfSnapshot(opts: HfDownloadOptions): Promise<{ dir: string; files: string[] }> {
  const hub = hubFor(opts.repo, opts);
  const include = opts.include ?? diffusersFilter;
  const files = (await listFiles(hub)).filter((file) => include(file.path));
  mkdirSync(opts.dest, { recursive: true });

  const overallTotal = files.reduce((sum, file) => sum + file.size, 0);
  let completed = 0;
  for (const file of files) {
    const target = join(opts.dest, file.path);
    if (sizeOf(target) !== file.size) {
      const report = (received: number) =>
        opts.onProgress?.({
          file: file.path,
          received,
          total: file.size,
          overallReceived: completed + received,
          overallTotal,
        });
      let lastReport = -Infinity;
      await downloadFile(hub, file, target, (received) => {
        const now = performance.now();
        if (now - lastReport < PROGRESS_INTERVAL_MS) return;
        lastReport = now;
        report(received);
      });
      report(file.size);
    }
    completed += file.size;
  }
  return { dir: opts.dest, files: files.map((file) => file.path) };
}

/** Where to reach the Hub, and as whom. */
interface Hub {
  endpoint: string;
  repo: string;
  revision: string;
  token: string | undefined;
}

function hubFor(repo: string, opts: { revision?: string; token?: string; endpoint?: string }): Hub {
  if (!REPO_ID.test(repo)) throw new Error(`"${repo}" is not a Hugging Face model id like owner/name.`);
  const endpoint = (opts.endpoint ?? (process.env.HF_ENDPOINT || DEFAULT_ENDPOINT)).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]/i.test(endpoint)) {
    throw new Error(`"${endpoint}" is not a Hugging Face endpoint. Use a URL like ${DEFAULT_ENDPOINT}.`);
  }
  return { endpoint, repo, revision: opts.revision ?? 'main', token: opts.token ?? process.env.HF_TOKEN };
}

async function listFiles(hub: Hub): Promise<HfFile[]> {
  const url = `${hub.endpoint}/api/models/${hub.repo}/revision/${encodeURIComponent(hub.revision)}?blobs=true`;
  const body = await withRetries(async () => {
    const res = await request(url, authHeaders(hub));
    if (!res.ok) throw hubError(hub, res);
    return (await res.json().catch(() => null)) as { siblings?: unknown } | null;
  });
  const unexpected = () => new Error(`Unexpected reply from ${hub.endpoint} while listing ${hub.repo}.`);
  const siblings = body?.siblings;
  if (!Array.isArray(siblings)) throw unexpected();
  return siblings.map((entry: { rfilename?: unknown; size?: unknown } | null) => {
    const path = entry?.rfilename;
    const size = entry?.size;
    if (typeof path !== 'string' || typeof size !== 'number') throw unexpected();
    // Paths come from the server and become local file names, so none may climb out of `dest`.
    if (!path.split(/[\\/]/).every((part) => part !== '' && part !== '.' && part !== '..')) {
      throw new Error(`Refusing to download ${hub.repo}: "${path}" would be written outside the destination folder.`);
    }
    return { path, size };
  });
}

/** Fetch one file into `<target>.partial`, continuing whatever is there, then move it into place. */
async function downloadFile(
  hub: Hub,
  file: HfFile,
  target: string,
  onBytes: (received: number) => void,
): Promise<void> {
  const partial = `${target}.partial`;
  const encodedPath = file.path.split('/').map(encodeURIComponent).join('/');
  const url = `${hub.endpoint}/${hub.repo}/resolve/${encodeURIComponent(hub.revision)}/${encodedPath}`;
  const mismatch = () =>
    new SizeMismatchError(
      `${file.path} does not match the size Hugging Face lists (${file.size} bytes), so it was deleted. ` +
        'Run the command again to fetch it fresh.',
    );
  mkdirSync(dirname(target), { recursive: true });

  try {
    await withRetries(async () => {
      let have = sizeOf(partial) ?? 0;
      if (have > file.size) {
        rmSync(partial);
        have = 0;
      }
      // Finished last time but never moved into place. Asking for the bytes past the end would get a 416.
      if (have > 0 && have === file.size) return;

      const headers: Record<string, string> = { ...authHeaders(hub), 'accept-encoding': 'identity' };
      if (have > 0) headers.range = `bytes=${have}-`;
      const res = await request(url, headers);
      if (res.status === 416) {
        discard(res);
        throw mismatch();
      }
      if (!res.ok) throw hubError(hub, res, file.path);

      // A 206 continues the partial file; a 200 means the server ignored the range, so start over.
      let received = res.status === 206 ? have : 0;
      const out = createWriteStream(partial, { flags: received > 0 ? 'a' : 'w' });
      try {
        await pipeline(
          bodyOf(res, file.path),
          async function* (chunks: AsyncIterable<Uint8Array>) {
            for await (const chunk of chunks) {
              received += chunk.length;
              if (received > file.size) throw mismatch();
              onBytes(received);
              yield chunk;
            }
          },
          out,
        );
      } catch (err) {
        // pipeline can settle before the file is closed; the next attempt needs its final size.
        await finished(out).catch(() => undefined);
        throw err;
      }
    });
    if (sizeOf(partial) !== file.size) throw mismatch();
  } catch (err) {
    if (err instanceof SizeMismatchError) rmSync(partial, { force: true });
    // Whatever arrived is kept in the .partial file, so the next run picks up from there.
    if (err instanceof RetryableError) {
      throw new Error(`${err.message} Run the command again to resume.`, { cause: err });
    }
    throw err;
  }
  renameSync(partial, target);
}

async function withRetries<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt > MAX_RETRIES) throw err;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

async function request(url: string, headers: Record<string, string>): Promise<Response> {
  try {
    return await fetch(url, { headers });
  } catch (err) {
    throw new RetryableError(`Could not reach ${new URL(url).host} (${reason(err)}).`);
  }
}

/** A response body whose connection failures are marked as worth retrying. */
async function* bodyOf(res: Response, path: string): AsyncGenerator<Uint8Array> {
  if (!res.body) return;
  try {
    yield* res.body as unknown as AsyncIterable<Uint8Array>;
  } catch (err) {
    throw new RetryableError(`Lost the connection while downloading ${path} (${reason(err)}).`);
  }
}

/** Turn a failed response into an error that says what to do about it. */
function hubError(hub: Hub, res: Response, path?: string): Error {
  discard(res);
  if (res.status === 401 || res.status === 403) {
    return new Error(
      `This model is gated or private. Accept its licence at https://huggingface.co/${hub.repo} and set HF_TOKEN.`,
    );
  }
  if (res.status === 404) {
    if (res.headers.get('x-error-code') === 'RevisionNotFound') {
      return new Error(`Revision "${hub.revision}" of ${hub.repo} was not found on Hugging Face.`);
    }
    return new Error(
      path ? `${path} was not found in ${hub.repo} on Hugging Face.` : `Model ${hub.repo} was not found on Hugging Face.`,
    );
  }
  const message = `Hugging Face returned HTTP ${res.status} for ${path ?? hub.repo}.`;
  return res.status === 429 || res.status >= 500 ? new RetryableError(message) : new Error(message);
}

function authHeaders(hub: Hub): Record<string, string> {
  return hub.token ? { authorization: `Bearer ${hub.token}` } : {};
}

/** Let go of a body we won't read, so its connection can be reused. */
function discard(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

function sizeOf(path: string): number | null {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat?.isFile() ? stat.size : null;
}

/** fetch reports network failures as "fetch failed", with the real reason in `cause`. */
function reason(err: unknown): string {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
  return cause instanceof Error ? cause.message : String(cause);
}
