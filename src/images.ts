/**
 * Input pictures for edits. The engine decodes PNG, JPEG and WebP; anything else macOS can open
 * (HEIC from iPhones, TIFF, GIF, BMP, AVIF) is converted to PNG first with the built-in `sips`.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ImageKind = 'png' | 'jpeg' | 'webp' | 'other';

export function imageKind(bytes: Buffer): ImageKind {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return 'other';
}

/** Bytes the engine can decode: unchanged if it already can (or PNG when asked), otherwise converted to PNG. */
export async function prepareImage(bytes: Buffer, label = 'input image', { png = false } = {}): Promise<Buffer> {
  const kind = imageKind(bytes);
  if (kind === 'png' || (kind !== 'other' && !png)) return bytes;
  const dir = await mkdtemp(join(tmpdir(), 'imagine-convert-'));
  try {
    const input = join(dir, 'input');
    const output = join(dir, 'output.png');
    await writeFile(input, bytes);
    await execFileAsync('sips', ['-s', 'format', 'png', input, '--out', output]);
    // Photos larger than the model can use are scaled down (longest side 2048), never up.
    const png = await readFile(output);
    if (Math.max(png.readUInt32BE(16), png.readUInt32BE(20)) <= 2048) return png;
    await execFileAsync('sips', ['-Z', '2048', output]);
    return await readFile(output);
  } catch {
    throw new Error(`Couldn't read ${label}: use a PNG, JPEG, WebP, HEIC, TIFF, GIF or BMP file.`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
