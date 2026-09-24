import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  diffusersFilter,
  downloadHfSnapshot,
  listHfFiles,
  parseHfRepo,
  type HfProgress,
} from '../src/huggingface.ts';

// A real token or mirror in the environment must not leak into these tests.
delete process.env.HF_TOKEN;
delete process.env.HF_ENDPOINT;

const json = (value: unknown) => Buffer.from(JSON.stringify(value));

/** black-forest-labs/FLUX.2-klein-4B as the Hub lists it, with small stand-ins for the weights. */
const KLEIN: Record<string, Buffer> = {
  '.gitattributes': Buffer.from('*.safetensors filter=lfs diff=lfs merge=lfs -text\n'),
  'LICENSE.md': Buffer.from('Apache License 2.0\n'),
  'README.md': Buffer.from('# FLUX.2 [klein] 4B\n'),
  'editing.jpg': randomBytes(300),
  'flux-2-klein-4b.safetensors': randomBytes(5000),
  'model_index.json': json({ _class_name: 'Flux2KleinPipeline' }),
  'others.jpg': randomBytes(300),
  'realism.jpg': randomBytes(300),
  'scheduler/scheduler_config.json': json({ _class_name: 'FlowMatchEulerDiscreteScheduler' }),
  'text_encoder/config.json': json({ architectures: ['Qwen3ForCausalLM'] }),
  'text_encoder/generation_config.json': json({}),
  'text_encoder/model-00001-of-00002.safetensors': randomBytes(3000),
  'text_encoder/model-00002-of-00002.safetensors': randomBytes(2000),
  'text_encoder/model.safetensors.index.json': json({ weight_map: {} }),
  'tokenizer/added_tokens.json': json({}),
  'tokenizer/chat_template.jinja': Buffer.from('{% for message in messages %}{{ message.content }}{% endfor %}'),
  'tokenizer/merges.txt': Buffer.from('#version: 0.2\n'),
  'tokenizer/special_tokens_map.json': json({}),
  'tokenizer/tokenizer.json': json({ model: { type: 'BPE' } }),
  'tokenizer/tokenizer_config.json': json({ tokenizer_class: 'Qwen2Tokenizer' }),
  'tokenizer/vocab.json': json({}),
  'transformer/config.json': json({ _class_name: 'Flux2Transformer2DModel' }),
  // Big enough to arrive in many chunks, so progress throttling shows.
  'transformer/diffusion_pytorch_model.safetensors': randomBytes(4 * 1024 * 1024),
  'vae/config.json': json({ _class_name: 'AutoencoderKLFlux2' }),
  'vae/diffusion_pytorch_model.safetensors': randomBytes(10_000),
};
const DROPPED = [
  '.gitattributes',
  'LICENSE.md',
  'README.md',
  'editing.jpg',
  'flux-2-klein-4b.safetensors',
  'others.jpg',
  'realism.jpg',
];
const PIPELINE = Object.keys(KLEIN).filter((path) => !DROPPED.includes(path));
const PIPELINE_BYTES = PIPELINE.reduce((sum, path) => sum + KLEIN[path]!.length, 0);
const WEIGHTS = 'transformer/diffusion_pytorch_model.safetensors';

interface MockRepo {
  files: Record<string, Buffer>;
  /** Sizes the listing claims, where they differ from the bytes served. */
  listedSizes?: Record<string, number>;
  /** Statuses the next listing requests get before one succeeds. */
  listFaults?: number[];
  /** Answer every listing request with this status. */
  listStatus?: number;
  /** Answer every file request with this status. */
  fileStatus?: number;
  /** The only token this repo accepts. */
  token?: string;
  /** Serve whole files even when a range is asked for. */
  ignoreRange?: boolean;
  /**
   * Per file, what the next requests get instead: a status, 'drop' to cut the connection halfway, or
   * 'slow' to send the headers straight away and the body a little later.
   */
  faults?: Record<string, Array<number | 'drop' | 'slow'>>;
}

interface Logged {
  path: string;
  range?: string;
  authorization?: string;
  status: number;
}

const repos = new Map<string, MockRepo>();
const log: Logged[] = [];
let server: Server;
let endpoint: string;

// A stand-in for the Hub: the model API under /api/models and file downloads under /<repo>/resolve.
before(async () => {
  server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const entry: Logged = {
      path: decodeURIComponent(pathname),
      range: req.headers.range,
      authorization: req.headers.authorization,
      status: 0,
    };
    log.push(entry);
    const send = (status: number, body: string | Buffer = '', headers: Record<string, string> = {}) => {
      entry.status = status;
      res.writeHead(status, { 'content-length': String(Buffer.byteLength(body)), ...headers }).end(body);
    };

    const listing = /^\/api\/models\/([^/]+\/[^/]+)\/revision\/([^/]+)$/.exec(pathname);
    const download = /^\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(pathname);
    const repo = repos.get((listing ?? download)?.[1] ?? '');
    if (!repo) return send(404, '{"error":"Repository not found"}');
    if (repo.token && req.headers.authorization !== `Bearer ${repo.token}`) return send(401);

    if (listing) {
      if (listing[2] !== 'main') return send(404, '{"error":"Invalid rev id"}', { 'x-error-code': 'RevisionNotFound' });
      const fault = repo.listFaults?.shift() ?? repo.listStatus;
      if (fault) return send(fault);
      const siblings = Object.entries(repo.files).map(([rfilename, data]) => ({
        rfilename,
        size: repo.listedSizes?.[rfilename] ?? data.length,
      }));
      return send(200, JSON.stringify({ siblings }), { 'content-type': 'application/json' });
    }

    const file = decodeURIComponent(download?.[2] ?? '');
    const data = repo.files[file];
    if (!data) return send(404, '', { 'x-error-code': 'EntryNotFound' });
    const fault = repo.faults?.[file]?.shift() ?? repo.fileStatus;
    if (fault === 'drop') {
      entry.status = 200;
      res.writeHead(200, { 'content-length': String(data.length) });
      // Give the client time to take in the first half before the connection dies.
      res.write(data.subarray(0, data.length / 2), () => setTimeout(() => res.destroy(), 50));
      return;
    }
    if (fault === 'slow') {
      entry.status = 200;
      res.writeHead(200, { 'content-length': String(data.length) }).flushHeaders();
      setTimeout(() => res.end(data), 30);
      return;
    }
    if (fault) return send(fault);
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (range && !repo.ignoreRange) {
      const start = Number(range[1]);
      if (start >= data.length) return send(416);
      return send(206, data.subarray(start), { 'content-range': `bytes ${start}-${data.length - 1}/${data.length}` });
    }
    send(200, data);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

const tempDirs: string[] = [];

after(() => {
  server.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'imagine-hf-'));
  tempDirs.push(dir);
  return dir;
}

/** The file requests the server saw for a repo. */
function downloads(repo: string, path?: string): Logged[] {
  const prefix = `/${repo}/resolve/main/`;
  return log.filter((r) => r.path.startsWith(prefix) && (path === undefined || r.path === prefix + path));
}

function partialFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.partial'));
}

test('parseHfRepo reads repo ids, hf: references and Hugging Face URLs', () => {
  const repo = 'black-forest-labs/FLUX.2-klein-4B';
  assert.deepEqual(parseHfRepo(repo), { repo });
  assert.deepEqual(parseHfRepo(`hf:${repo}`), { repo });
  assert.deepEqual(parseHfRepo(`https://huggingface.co/${repo}`), { repo });
  assert.deepEqual(parseHfRepo(`https://huggingface.co/${repo}/tree/main`), { repo, revision: 'main' });
  assert.deepEqual(parseHfRepo(`https://huggingface.co/${repo}/tree/refs%2Fpr%2F3/transformer`), {
    repo,
    revision: 'refs/pr/3',
  });
  // Ollama model names have the same shape. Accepting them is deliberate: the caller decides which wins.
  assert.deepEqual(parseHfRepo('x/flux2-klein'), { repo: 'x/flux2-klein' });

  for (const ref of [
    './local/dir',
    '/Users/me/models/flux',
    '~/flux',
    'flux',
    'a/b/c',
    'x/flux2-klein:9b',
    'hf:',
    '',
    'https://huggingface.co/datasets/owner/name',
    'https://example.com/owner/name',
  ]) {
    assert.equal(parseHfRepo(ref), null, ref);
  }
});

test('diffusersFilter keeps a diffusers pipeline and drops everything else', () => {
  assert.deepEqual(Object.keys(KLEIN).filter(diffusersFilter), PIPELINE);
  for (const path of [
    'model.bin',
    'sd_xl_base_1.0.ckpt',
    'text_encoder/pytorch_model.bin',
    'unet/diffusion_pytorch_model.pt',
    'vae/model.pth',
    'onnx/unet/model.onnx',
    'text_encoder/flax_model.msgpack',
    'text_encoder/tf_model.h5',
    'docs/usage.md',
    'assets/sample.webp',
    'samples/grid.gif',
    'samples/cat.jpeg',
    'samples/dog.png',
    '.github/config.json',
  ]) {
    assert.equal(diffusersFilter(path), false, path);
  }
  for (const path of ['config.json', 'tokenizer_2/spiece.model', 'tokenizer/vocab.tiktoken', 'tokenizer/vocab.txt']) {
    assert.equal(diffusersFilter(path), true, path);
  }
});

test('downloads the pipeline files byte for byte, with throttled progress', async () => {
  repos.set('bfl/klein', { files: KLEIN });
  assert.deepEqual(
    await listHfFiles('bfl/klein', { endpoint }),
    Object.entries(KLEIN).map(([path, data]) => ({ path, size: data.length })),
  );

  const dest = tempDir();
  const events: HfProgress[] = [];
  const result = await downloadHfSnapshot({ repo: 'bfl/klein', dest, endpoint, onProgress: (p) => events.push(p) });

  assert.deepEqual(result, { dir: dest, files: PIPELINE });
  assert.deepEqual(
    downloads('bfl/klein').map((r) => r.path.slice('/bfl/klein/resolve/main/'.length)),
    PIPELINE,
    'one request per file, in order',
  );
  for (const path of PIPELINE) assert.deepEqual(readFileSync(join(dest, path)), KLEIN[path], path);
  for (const path of DROPPED) assert.equal(existsSync(join(dest, path)), false, path);
  assert.deepEqual(partialFiles(dest), []);

  for (const path of PIPELINE) {
    const last = events.filter((e) => e.file === path).at(-1);
    assert.deepEqual([last?.received, last?.total], [KLEIN[path]!.length, KLEIN[path]!.length], path);
  }
  assert.deepEqual([events.at(-1)?.overallReceived, events.at(-1)?.overallTotal], [PIPELINE_BYTES, PIPELINE_BYTES]);
  assert.ok(events.every((e, i) => i === 0 || e.overallReceived >= events[i - 1]!.overallReceived));
  const weightEvents = events.filter((e) => e.file === WEIGHTS).length;
  assert.ok(weightEvents <= 5, `a 4 MB file on loopback reported progress ${weightEvents} times`);
});

test('a second run skips complete files and fetches only a damaged one', async () => {
  repos.set('bfl/again', { files: KLEIN });
  const dest = tempDir();
  await downloadHfSnapshot({ repo: 'bfl/again', dest, endpoint });
  const vae = 'vae/diffusion_pytorch_model.safetensors';
  truncateSync(join(dest, vae), 10);
  log.length = 0;

  const events: HfProgress[] = [];
  const result = await downloadHfSnapshot({ repo: 'bfl/again', dest, endpoint, onProgress: (p) => events.push(p) });
  assert.deepEqual(result.files, PIPELINE);
  assert.deepEqual(
    downloads('bfl/again').map((r) => r.path),
    [`/bfl/again/resolve/main/${vae}`],
  );
  assert.deepEqual(readFileSync(join(dest, vae)), KLEIN[vae]);
  // Everything already on disk counts towards overall progress from the first report.
  assert.ok(events[0]!.overallReceived >= PIPELINE_BYTES - KLEIN[vae]!.length);
  assert.equal(events.at(-1)?.overallReceived, PIPELINE_BYTES);
});

test('resumes a .partial file with a Range request', async () => {
  const weights = randomBytes(64 * 1024);
  repos.set('bfl/resume', { files: { [WEIGHTS]: weights } });
  const dest = tempDir();
  mkdirSync(join(dest, 'transformer'));
  writeFileSync(join(dest, `${WEIGHTS}.partial`), weights.subarray(0, 1000));

  const events: HfProgress[] = [];
  await downloadHfSnapshot({ repo: 'bfl/resume', dest, endpoint, onProgress: (p) => events.push(p) });
  assert.deepEqual(
    downloads('bfl/resume').map((r) => [r.range, r.status]),
    [['bytes=1000-', 206]],
  );
  assert.deepEqual(readFileSync(join(dest, WEIGHTS)), weights);
  assert.deepEqual(partialFiles(dest), []);
  assert.ok(events[0]!.received > 1000, 'progress starts from the bytes already on disk');
});

test('starts over cleanly when the server ignores the Range header', async () => {
  const weights = randomBytes(64 * 1024);
  const stale = Buffer.from('bytes left over from some other download');
  repos.set('bfl/no-range', { files: { [WEIGHTS]: weights }, ignoreRange: true });
  const dest = tempDir();
  mkdirSync(join(dest, 'transformer'));
  writeFileSync(join(dest, `${WEIGHTS}.partial`), stale);

  await downloadHfSnapshot({ repo: 'bfl/no-range', dest, endpoint });
  assert.deepEqual(
    downloads('bfl/no-range').map((r) => [r.range, r.status]),
    [[`bytes=${stale.length}-`, 200]],
  );
  assert.deepEqual(readFileSync(join(dest, WEIGHTS)), weights);
});

test('a file that does not match its listed size is deleted and reported', async () => {
  const vae = 'vae/diffusion_pytorch_model.safetensors';
  // One server sends less than the listing promised, the other more.
  repos.set('bfl/short', { files: { [vae]: randomBytes(1000) }, listedSizes: { [vae]: 1500 } });
  repos.set('bfl/long', { files: { [vae]: randomBytes(100_000) }, listedSizes: { [vae]: 1000 } });
  for (const repo of ['bfl/short', 'bfl/long']) {
    const dest = tempDir();
    await assert.rejects(downloadHfSnapshot({ repo, dest, endpoint }), /does not match the size Hugging Face lists/);
    assert.equal(existsSync(join(dest, vae)), false, repo);
    assert.deepEqual(partialFiles(dest), [], repo);
    assert.equal(downloads(repo).length, 1, `${repo}: a bad size is not retried`);
  }
});

test('a disk error fails the download without crashing or retrying', async () => {
  // The body arrives late, so the file stream fails while the download is still waiting for bytes.
  repos.set('bfl/disk', { files: { [WEIGHTS]: randomBytes(64 * 1024) }, faults: { [WEIGHTS]: ['slow'] } });
  const dest = tempDir();
  // A folder where the partial file belongs makes opening it fail.
  mkdirSync(join(dest, `${WEIGHTS}.partial`), { recursive: true });
  await assert.rejects(downloadHfSnapshot({ repo: 'bfl/disk', dest, endpoint }), { code: 'EISDIR' });
  assert.equal(downloads('bfl/disk').length, 1);
});

test('a gated model says how to get access', async () => {
  const message =
    'This model is gated or private. Accept its licence at https://huggingface.co/bfl/gated and set HF_TOKEN.';
  repos.set('bfl/gated', { files: KLEIN, listStatus: 403 });
  await assert.rejects(downloadHfSnapshot({ repo: 'bfl/gated', dest: tempDir(), endpoint }), { message });

  // The Hub lists gated repos to anyone and only refuses the downloads.
  repos.set('bfl/gated', { files: KLEIN, fileStatus: 401 });
  await assert.rejects(downloadHfSnapshot({ repo: 'bfl/gated', dest: tempDir(), endpoint }), { message });
  assert.equal(downloads('bfl/gated').length, 1, 'access errors are not retried');
});

test('a missing model or revision says so, and other statuses give the code', async () => {
  await assert.rejects(listHfFiles('bfl/nope', { endpoint }), {
    message: 'Model bfl/nope was not found on Hugging Face.',
  });
  assert.equal(log.filter((r) => r.path.startsWith('/api/models/bfl/nope/')).length, 1, 'a 404 is not retried');

  repos.set('bfl/real', { files: KLEIN });
  await assert.rejects(listHfFiles('bfl/real', { endpoint, revision: 'no-such-branch' }), {
    message: 'Revision "no-such-branch" of bfl/real was not found on Hugging Face.',
  });

  repos.set('bfl/odd', { files: KLEIN, listStatus: 400 });
  await assert.rejects(listHfFiles('bfl/odd', { endpoint }), /HTTP 400/);
  await assert.rejects(listHfFiles('not a repo', { endpoint }), /owner\/name/);
});

test('sends the token, or HF_TOKEN, as a Bearer token', async () => {
  const files = { 'model_index.json': json({}) };
  const authOf = (repo: string) => log.filter((r) => r.path.includes(`/${repo}/`)).map((r) => r.authorization);

  repos.set('bfl/private-a', { files, token: 'hf_given' });
  await downloadHfSnapshot({ repo: 'bfl/private-a', dest: tempDir(), endpoint, token: 'hf_given' });
  assert.deepEqual(authOf('bfl/private-a'), ['Bearer hf_given', 'Bearer hf_given'], 'listing and download');

  repos.set('bfl/private-b', { files, token: 'hf_from_env' });
  process.env.HF_TOKEN = 'hf_from_env';
  try {
    await downloadHfSnapshot({ repo: 'bfl/private-b', dest: tempDir(), endpoint });
  } finally {
    delete process.env.HF_TOKEN;
  }
  assert.deepEqual(authOf('bfl/private-b'), ['Bearer hf_from_env', 'Bearer hf_from_env']);

  repos.set('bfl/private-c', { files, token: 'hf_secret' });
  await assert.rejects(downloadHfSnapshot({ repo: 'bfl/private-c', dest: tempDir(), endpoint }), /gated or private/);
  assert.deepEqual(authOf('bfl/private-c'), [undefined], 'no token, no header');
});

test('retries a 429, a 500 and a dropped connection, resuming what arrived', async () => {
  const weights = randomBytes(256 * 1024);
  repos.set('bfl/flaky', {
    files: { 'model_index.json': json({}), [WEIGHTS]: weights },
    listFaults: [429],
    faults: { 'model_index.json': [500], [WEIGHTS]: ['drop'] },
  });
  const dest = tempDir();
  await downloadHfSnapshot({ repo: 'bfl/flaky', dest, endpoint });

  assert.deepEqual(
    log.filter((r) => r.path.startsWith('/api/models/bfl/flaky/')).map((r) => r.status),
    [429, 200],
  );
  assert.deepEqual(
    downloads('bfl/flaky', 'model_index.json').map((r) => r.status),
    [500, 200],
  );
  const [dropped, retried, ...rest] = downloads('bfl/flaky', WEIGHTS);
  assert.deepEqual([dropped?.range, dropped?.status, rest.length], [undefined, 200, 0]);
  assert.match(retried?.range ?? '', /^bytes=[1-9]\d*-$/, 'the retry continues from the bytes on disk');
  assert.equal(retried?.status, 206);
  assert.deepEqual(readFileSync(join(dest, WEIGHTS)), weights);
  assert.deepEqual(partialFiles(dest), []);
});

test('refuses file paths that would escape the destination', async () => {
  for (const evil of ['../escape.json', 'transformer/../../escape.json', '/tmp/escape.json']) {
    repos.set('bfl/evil', { files: { 'model_index.json': json({}), [evil]: json({}) } });
    const dest = tempDir();
    // Even a filter that lets everything through must not get the chance to write it.
    await assert.rejects(
      downloadHfSnapshot({ repo: 'bfl/evil', dest, endpoint, include: () => true }),
      /would be written outside the destination folder/,
    );
    assert.deepEqual(readdirSync(dest), [], evil);
  }
  assert.equal(downloads('bfl/evil').length, 0);
});
