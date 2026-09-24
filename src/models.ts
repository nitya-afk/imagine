/** Model names, the library catalogue, and whether a model fits in this Mac's memory. */
import { totalmem } from 'node:os';
import { KNOWN_MODELS } from './config.ts';

/** Library aliases that point at a specific variant. */
const ALIASES: Record<string, string> = {
  'x/flux2-klein:latest': 'x/flux2-klein:4b-fp4',
  'x/flux2-klein:4b': 'x/flux2-klein:4b-fp4',
  'x/flux2-klein:9b': 'x/flux2-klein:9b-fp4',
  'x/z-image-turbo:latest': 'x/z-image-turbo:fp8',
};

export function withTag(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1).includes(':') ? name : `${name}:latest`;
}

/** Resolve aliases so "x/flux2-klein" and "x/flux2-klein:4b-fp4" compare equal. */
export function canonicalModel(name: string): string {
  const tagged = withTag(name);
  return ALIASES[tagged] ?? tagged;
}

/** Accept "flux2-klein:9b-fp4" for "x/flux2-klein:9b-fp4": the library image models live under x/. */
export function normalizeModelName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.includes('/')) return trimmed;
  const base = trimmed.split(':')[0];
  return KNOWN_MODELS.some((m) => m.name.startsWith(`x/${base}:`)) ? `x/${trimmed}` : trimmed;
}

export type Fit = 'fits' | 'tight' | 'too big';

/**
 * The engine refuses to load a model larger than MLX's memory limit, which macOS sets to about
 * three quarters of RAM. Below half of RAM there is room for everything else you have open.
 */
export function memoryFit(modelBytes: number, ramBytes = totalmem()): Fit {
  if (modelBytes <= ramBytes * 0.5) return 'fits';
  if (modelBytes <= ramBytes * 0.75) return 'tight';
  return 'too big';
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}
