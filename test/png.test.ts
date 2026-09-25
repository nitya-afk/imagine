import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { crc32, pngSize, readMetadata, withMetadata, type ImageMeta } from '../src/png.ts';

/** A real, minimal 3×2 RGB PNG. */
function tinyPng(width = 3, height = 2): Buffer {
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
  const raw = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const META: ImageMeta = {
  prompt: 'a cat on the moon, café lights, 月',
  idea: 'cat moon',
  model: 'x/flux2-klein',
  seed: 42,
  width: 3,
  height: 2,
  steps: 4,
  edit: false,
  generator: 'imagine test',
};

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('metadata round-trips, including non-Latin text', () => {
  const png = withMetadata(tinyPng(), META);
  assert.deepEqual(readMetadata(png), META);
  assert.deepEqual(pngSize(png), { width: 3, height: 2 });
  assert.ok(png.toString('latin1').includes('Seed: 42, Size: 3x2'), 'parameters chunk for other tools');
});

test('every chunk stays well-formed and IEND stays last', () => {
  const png = withMetadata(tinyPng(), META);
  const types: string[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const body = png.subarray(at + 4, at + 8 + length);
    assert.equal(png.readUInt32BE(at + 8 + length), crc32(body), `CRC of ${body.toString('latin1', 0, 4)}`);
    types.push(body.toString('latin1', 0, 4));
    at += 12 + length;
  }
  assert.deepEqual(types, ['IHDR', 'IDAT', 'iTXt', 'iTXt', 'IEND']);
});

test('images without metadata, and non-PNGs, are handled', () => {
  assert.equal(readMetadata(tinyPng()), null);
  assert.equal(readMetadata(Buffer.from('not a png')), null);
  const notPng = Buffer.from('plain bytes');
  assert.equal(withMetadata(notPng, META), notPng);
});
