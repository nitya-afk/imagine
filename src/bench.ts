/** `imagine bench`: a fixed workload so speeds from different Macs can be compared. */
import { execFileSync } from 'node:child_process';
import { totalmem } from 'node:os';

export const BENCH_PROMPT = 'a lighthouse on a rocky coast at dusk, waves, dramatic sky, photo';

/** The runs, in order: the first one also loads the model. */
export const BENCH_RUNS = [
  { size: 512, seed: 1, warmup: true },
  { size: 512, seed: 2, warmup: false },
  { size: 512, seed: 3, warmup: false },
  { size: 1024, seed: 4, warmup: false },
  { size: 1024, seed: 5, warmup: false },
] as const;

export interface BenchReport {
  chip: string;
  memoryGB: number;
  model: string;
  version: string;
  firstRun: number;
  small: number[];
  large: number[];
}

export function machine(): { chip: string; memoryGB: number } {
  let chip = 'Unknown Mac';
  try {
    chip = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim() || chip;
  } catch {
    // Not fatal: the timings still stand.
  }
  return { chip, memoryGB: Math.round(totalmem() / 2 ** 30) };
}

const average = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
const seconds = (value: number) => `${value.toFixed(1)} s`;

export function formatBench(r: BenchReport): string {
  const small = average(r.small);
  const large = average(r.large);
  return [
    `imagine bench: ${r.chip}, ${r.memoryGB} GB, ${r.model}`,
    '',
    `  load + first 512×512   ${seconds(r.firstRun)}`,
    `  512×512                ${seconds(small)} per image (average of ${r.small.length})`,
    `  1024×1024              ${seconds(large)} per image (average of ${r.large.length})`,
    '',
    'Share your result:',
    `| ${r.chip} | ${r.memoryGB} GB | ${r.model} | ${seconds(small)} | ${seconds(large)} | imagine ${r.version} |`,
  ].join('\n');
}
