/** Parsing and naming helpers shared by the CLI and the API server. */
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface Size {
  width: number;
  height: number;
}

const MIN_SIDE = 256;
const MAX_SIDE = 2048;

/** Parse "1024x1024". Sides must be multiples of 16, which diffusion models need. */
export function parseSize(value: string): Size {
  const match = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid size "${value}". Use WIDTHxHEIGHT, for example 1024x1024.`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  for (const side of [width, height]) {
    if (side < MIN_SIDE || side > MAX_SIDE || side % 16 !== 0) {
      throw new Error(
        `Invalid size "${value}". Each side must be between ${MIN_SIDE} and ${MAX_SIDE} and a multiple of 16.`,
      );
    }
  }
  return { width, height };
}

export function parseIntInRange(value: string | number, name: string, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return n;
}

export const MAX_SEED = 2 ** 31 - 1;

/** We always pick the seed ourselves so it can go in the filename and be reproduced later. */
export function randomSeed(): number {
  return randomInt(1, MAX_SEED);
}

export function slugify(prompt: string, maxLength = 60): string {
  const slug = prompt
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return 'image';
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  const lastDash = cut.lastIndexOf('-');
  return lastDash > maxLength / 2 ? cut.slice(0, lastDash) : cut;
}

function timestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** "20260924-143525-cat-blasting-off-from-the-sun-1234567.png", made unique within the folder. */
export function imageFileName(dir: string, prompt: string, seed: number, date = new Date()): string {
  const base = `${timestamp(date)}-${slugify(prompt)}-${seed}`;
  let name = `${base}.png`;
  for (let i = 2; existsSync(join(dir, name)); i++) name = `${base}-${i}.png`;
  return name;
}
