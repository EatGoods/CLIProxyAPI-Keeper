import { describe, expect, it } from 'vitest';
import { buildDurationHistogram, summarizeRangeValues } from './OverviewRangeMetricsPanel';

describe('OverviewRangeMetricsPanel', () => {
  it('summarizes the selected range without dropping idle buckets', () => {
    expect(summarizeRangeValues([0, 10, 20, 30])).toEqual({ average: 15, p95: 30, maximum: 30 });
  });

  it('builds an empty or populated duration distribution from valid samples only', () => {
    expect(buildDurationHistogram([null, 0])).toEqual({ labels: [], counts: [] });
    expect(buildDurationHistogram([100, 200, 300]).counts.reduce((sum, count) => sum + count, 0)).toBe(3);
  });
});
