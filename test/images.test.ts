import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { imageKind, prepareImage } from '../src/images.ts';
import { crc32 } from '../src/png.ts';

function png(width = 8, height = 8): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (1 + width * 3), 120);
  for (let y = 0; y < height; y++) raw[y * (1 + width * 3)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('recognises the formats the engine decodes directly', () => {
  assert.equal(imageKind(png()), 'png');
  assert.equal(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpeg');
  assert.equal(imageKind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])), 'webp');
  assert.equal(imageKind(Buffer.from('not an image')), 'other');
});

test('PNG, JPEG and WebP pass through untouched', async () => {
  const bytes = png();
  assert.equal(await prepareImage(bytes), bytes);
});

test('an iPhone HEIC photo is converted to PNG', { skip: process.platform !== 'darwin' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'imagine-heic-'));
  writeFileSync(join(dir, 'in.png'), png(32, 24));
  execFileSync('sips', ['-s', 'format', 'heic', join(dir, 'in.png'), '--out', join(dir, 'photo.heic')], { stdio: 'ignore' });
  const heic = readFileSync(join(dir, 'photo.heic'));
  assert.equal(imageKind(heic), 'other');
  const converted = await prepareImage(heic);
  assert.equal(imageKind(converted), 'png');
  assert.deepEqual([converted.readUInt32BE(16), converted.readUInt32BE(20)], [32, 24]);
});

test('unreadable input gets a clear error', { skip: process.platform !== 'darwin' }, async () => {
  await assert.rejects(prepareImage(Buffer.from('definitely not a picture'), 'input image 2'), /Couldn't read input image 2/);
});
