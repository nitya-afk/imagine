import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BENCH_RUNS, formatBench } from '../src/bench.ts';

test('the workload is fixed: a warm-up, then two runs at each size', () => {
  assert.deepEqual(BENCH_RUNS.map((r) => [r.size, r.warmup]), [[512, true], [512, false], [512, false], [1024, false], [1024, false]]);
});

test('the report averages runs and ends with a shareable row', () => {
  const text = formatBench({ chip: 'Apple M5 Pro', memoryGB: 24, model: 'x/flux2-klein', version: '1.2.0', firstRun: 9.04, small: [3, 4], large: [14, 15] });
  assert.match(text, /512×512\s+3\.5 s per image/);
  assert.match(text, /1024×1024\s+14\.5 s per image/);
  assert.ok(text.endsWith('| Apple M5 Pro | 24 GB | x/flux2-klein | 3.5 s | 14.5 s | imagine 1.2.0 |'));
});
