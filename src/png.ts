/**
 * Every image carries how it was made (prompt, seed, model, size) in PNG text chunks, so it can be
 * reproduced later with `imagine again`. A `parameters` chunk mirrors the format other image tools read.
 */

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const META_KEY = 'imagine';

export interface ImageMeta {
  prompt: string;
  /** The short idea the prompt was written from, when --enhance rewrote it. */
  idea?: string;
  model: string;
  seed: number;
  width: number;
  height: number;
  steps?: number;
  /** Edits can only be redone with the original pictures. */
  edit: boolean;
  generator: string;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function isPng(png: Buffer): boolean {
  return png.length > 33 && png.subarray(0, 8).equals(SIGNATURE);
}

/** Width and height from the IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (!isPng(png)) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** An iTXt chunk (UTF-8 text, so prompts in any language survive). */
function itxtChunk(keyword: string, text: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0, 0, 0, 0, 0]), // keyword end, no compression, method 0, empty language, empty translation
    Buffer.from(text, 'utf8'),
  ]);
  const type = Buffer.from('iTXt', 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, crc]);
}

/** Add the metadata chunks just before IEND. Anything that isn't a PNG is returned unchanged. */
export function withMetadata(png: Buffer, meta: ImageMeta): Buffer {
  if (!isPng(png)) return png;
  const iend = png.lastIndexOf(Buffer.from('IEND', 'latin1')) - 4;
  if (iend < 8) return png;
  const parameters =
    `${meta.prompt}\nSteps: ${meta.steps ?? 'default'}, Seed: ${meta.seed}, ` +
    `Size: ${meta.width}x${meta.height}, Model: ${meta.model}`;
  return Buffer.concat([
    png.subarray(0, iend),
    itxtChunk(META_KEY, JSON.stringify(meta)),
    itxtChunk('parameters', parameters),
    png.subarray(iend),
  ]);
}

/** The metadata `withMetadata` wrote, or null for images that weren't made by imagine. */
export function readMetadata(png: Buffer): ImageMeta | null {
  if (!isPng(png)) return null;
  for (let offset = 8; offset + 12 <= png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'iTXt') {
      const keywordEnd = data.indexOf(0);
      if (data.toString('latin1', 0, keywordEnd) === META_KEY) {
        // Skip the compression flag and method, then the language and translated keyword.
        let at = keywordEnd + 3;
        at = data.indexOf(0, at) + 1;
        at = data.indexOf(0, at) + 1;
        try {
          const meta = JSON.parse(data.toString('utf8', at)) as ImageMeta;
          return typeof meta.prompt === 'string' && typeof meta.seed === 'number' ? meta : null;
        } catch {
          return null;
        }
      }
    }
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  return null;
}
