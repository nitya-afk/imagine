import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { downloadFile, downloadVerified } from '../src/download.ts';

const DATA = Buffer.alloc(200_000, 7).map((_, i) => i % 251);
const SHA = createHash('sha256').update(DATA).digest('hex');
const fast = { stallWindowMs: 150, stallMinBytes: 1, retryDelayMs: 5 };

let server: Server;
let base: string;
const ranges: Array<string | undefined> = [];
let stallFirst = 0;
let failFirst = 0;
let requests = 0;

// /stall hangs after 50 kB on its first connection; /ignore-range always answers 200.
before(async () => {
  server = createServer((req, res) => {
    requests++;
    ranges.push(req.headers.range);
    if (req.url === '/missing') return void res.writeHead(404).end();
    if (req.url === '/flaky' && failFirst-- > 0) return void res.writeHead(503).end();
    if (req.url === '/trickle') {
      // Every connection delivers 20 kB more and then hangs: slow, but always moving.
      const start = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
      const body = DATA.subarray(start);
      res.writeHead(start > 0 ? 206 : 200, { 'content-length': body.length });
      res.write(body.subarray(0, 20_000));
      if (body.length <= 20_000) res.end();
      return;
    }
    const requested = Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
    if (requested > DATA.length) return void res.writeHead(416).end();

    const start = req.url !== '/ignore-range' ? Number(/bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0) : 0;
    const body = DATA.subarray(start);
    res.writeHead(start > 0 ? 206 : 200, { 'content-length': body.length });
    if (req.url === '/stall' && stallFirst-- > 0) {
      res.write(body.subarray(0, 50_000)); // …and never finish
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.closeAllConnections?.() ?? server.close());

const dir = mkdtempSync(join(tmpdir(), 'imagine-dl-'));

test('a stalled connection is replaced and the download resumes with Range', async () => {
  ranges.length = 0;
  stallFirst = 1;
  const file = join(dir, 'stall.bin');
  await downloadVerified(`${base}/stall`, file, SHA, fast);
  assert.deepEqual(readFileSync(file), DATA);
  assert.deepEqual(ranges, [undefined, 'bytes=50000-']);
});

test('a server that ignores Range restarts cleanly instead of appending', async () => {
  stallFirst = 0;
  const file = join(dir, 'ignore.bin');
  let first = true;
  await downloadFile(`${base}/ignore-range`, file, {
    ...fast,
    // Make the first attempt fail midway so the second one asks for a range.
    onProgress: (received) => {
      if (first && received >= 50_000) {
        first = false;
        throw new Error('simulated drop');
      }
    },
  });
  assert.deepEqual(readFileSync(file), DATA);
});

test('transient server errors are retried', async () => {
  failFirst = 2;
  const file = join(dir, 'flaky.bin');
  await downloadVerified(`${base}/flaky`, file, SHA, fast);
  assert.deepEqual(readFileSync(file), DATA);
});

test('a 404 fails at once, and a bad checksum leaves no file behind', async () => {
  await assert.rejects(downloadFile(`${base}/missing`, join(dir, 'missing.bin'), fast), /HTTP 404/);
  const file = join(dir, 'bad.bin');
  await assert.rejects(downloadVerified(`${base}/ok`, file, '0'.repeat(64), fast), /Checksum mismatch/);
  assert.equal(existsSync(file), false);
});

test('a partial file from an earlier run is resumed, not restarted', async () => {
  ranges.length = 0;
  const file = join(dir, 'earlier.bin');
  writeFileSync(file, DATA.subarray(0, 120_000));
  await downloadVerified(`${base}/ok`, file, SHA, fast);
  assert.deepEqual(readFileSync(file), DATA);
  assert.deepEqual(ranges, ['bytes=120000-']);
});

test('a file that already has the right checksum is not downloaded again', async () => {
  const file = join(dir, 'done.bin');
  writeFileSync(file, DATA);
  const before = requests;
  await downloadVerified(`${base}/ok`, file, SHA, fast);
  assert.equal(requests, before);
});

test('a leftover larger than the real file starts over', async () => {
  const file = join(dir, 'too-big.bin');
  writeFileSync(file, Buffer.alloc(DATA.length + 10, 1));
  await downloadVerified(`${base}/ok`, file, SHA, fast);
  assert.deepEqual(readFileSync(file), DATA);
});

test('a slow line that keeps moving never runs out of attempts', async () => {
  const file = join(dir, 'trickle.bin');
  // Ten connections are needed and only two failures in a row are allowed.
  await downloadVerified(`${base}/trickle`, file, SHA, { ...fast, maxAttempts: 2 });
  assert.deepEqual(readFileSync(file), DATA);
});

test('giving up names the reason and says a rerun resumes', async () => {
  // A port that was just free and has nothing listening.
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));

  await assert.rejects(
    downloadFile(`http://127.0.0.1:${port}/file`, join(dir, 'refused.bin'), { ...fast, maxAttempts: 2 }),
    /ECONNREFUSED.*Run the command again to resume/,
  );
});
