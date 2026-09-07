import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/chartjs';
import type { ChartData, ChartOptions } from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';
import type { AnalysisCompositionItem, AnalysisLatencyDiagnostics, AnalysisResponse, UsageOverviewSeries } from '@/lib/types';
import { formatCompactNumber, formatDurationMs, formatFixedTwoDecimals, formatPerMinuteValue, formatUsd } from '@/utils/usage';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import styles from '@/pages/UsagePage.module.scss';

type RangeDimensionKey = 'models' | 'api_keys' | 'auth_files' | 'ai_providers';

interface RangeSummary {
  average: number | null;
  p95: number | null;
  maximum: number | null;
}

interface DurationHistogram {
  labels: string[];
  counts: number[];
}

interface OverviewRangeMetricsPanelProps {
  usage?: { series?: UsageOverviewSeries; timezone?: string } | null;
  analysis?: AnalysisResponse | null;
  latency?: AnalysisLatencyDiagnostics | null;
  loading: boolean;
  analysisLoading: boolean;
  latencyLoading: boolean;
  analysisError?: string;
  latencyError?: string;
  isDark: boolean;
  isMobile: boolean;
}

const COLORS = {
  token: '#3b82f6',
  ttft: '#f59e0b',
  latency: '#22c55e',
  request: '#6366f1',
  cache: '#14b8a6',
} as const;

const DURATION_UNITS = { d: 'd', h: 'h', m: 'm', s: 's', ms: 'ms' } as const;

const finiteValues = (values: Array<number | null | undefined>): number[] => values
  .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

export function summarizeRangeValues(values: Array<number | null | undefined>): RangeSummary {
  const sorted = finiteValues(values).sort((left, right) => left - right);
  if (sorted.length === 0) return { average: null, p95: null, maximum: null };
  return {
    average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
    maximum: sorted[sorted.length - 1],
  };
}

export function buildDurationHistogram(values: Array<number | null | undefined>): DurationHistogram {
  const samples = finiteValues(values).filter((value) => value > 0);
  if (samples.length === 0) return { labels: [], counts: [] };
  const maximum = Math.max(...samples);
  const bucketCount = Math.min(12, Math.max(1, Math.ceil(Math.sqrt(samples.length))));
  const bucketWidth = maximum / bucketCount;
  const counts = Array.from({ length: bucketCount }, () => 0);
  for (const sample of samples) {
    counts[Math.min(bucketCount - 1, Math.floor(sample / bucketWidth))] += 1;
  }
  const format = (value: number) => formatDurationMs(value, { maxUnits: 2, locale: 'en-US', unitLabels: DURATION_UNITS });
  return {
    labels: counts.map((_, index) => `${format(index * bucketWidth)}–${format((index + 1) * bucketWidth)}`),
    counts,
  };
}

const formatBucket = (bucket: string, timezone?: string): string => {
  const parsed = Date.parse(bucket);
  if (!Number.isFinite(parsed)) return bucket;
  const timeZone = timezone?.trim() && timezone !== 'Local' ? timezone : undefined;
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).format(new Date(parsed));
  } catch {
    return new Date(parsed).toLocaleString();
  }
};

function buildLineOptions(isDark: boolean, isMobile: boolean, formatter: (value: number) => string): ChartOptions<'line'> {
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(17, 24, 39, 0.07)';
  const tickColor = isDark ? 'rgba(255, 255, 255, 0.66)' : 'rgba(17, 24, 39, 0.66)';
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (context) => `${context.dataset.label}: ${formatter(Number(context.parsed.y ?? 0))}` } },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: tickColor, maxTicksLimit: isMobile ? 5 : 8 } },
      y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor, callback: (value) => formatter(Number(value)) } },
    },
    elements: { line: { tension: 0.35, borderWidth: isMobile ? 1.6 : 2 }, point: { radius: 0, hoverRadius: 3 } },
  };
}

function buildBarOptions(isDark: boolean, isMobile: boolean): ChartOptions<'bar'> {
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(17, 24, 39, 0.07)';
  const tickColor = isDark ? 'rgba(255, 255, 255, 0.66)' : 'rgba(17, 24, 39, 0.66)';
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false }, ticks: { color: tickColor, maxRotation: 0, maxTicksLimit: isMobile ? 5 : 8 } },
      y: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: tickColor, callback: (value) => formatCompactNumber(Number(value)) } },
    },
  };
}

const buildLineData = (labels: string[], values: number[], label: string, color: string): ChartData<'line', number[], string> => ({
  labels,
  datasets: [{ label, data: values, borderColor: color, backgroundColor: `${color}24`, fill: true }],
});

function MetricChips({ summary, formatter }: { summary: RangeSummary; formatter: (value: number) => string }) {
  const { t } = useTranslation();
  const values = [
    [t('usage_stats.overview_realtime_average'), summary.average],
    [t('usage_stats.overview_range_p95'), summary.p95],
    [t('usage_stats.overview_range_maximum'), summary.maximum],
  ] as const;
  return (
    <div className={styles.overviewRealtimeMetrics} title={t('usage_stats.overview_range_metric_hint')}>
      {values.map(([label, value]) => (
        <span key={label} className={styles.overviewRealtimeMetric}>
          <span className={styles.overviewRealtimeMetricLabel}>{label}</span>
          <span className={styles.overviewRealtimeMetricValue}>{value == null ? '--' : formatter(value)}</span>
        </span>
      ))}
    </div>
  );
}

function RangeCard({ title, summary, formatter, compact = false, full = false, children }: {
  title: string;
  summary?: RangeSummary;
  formatter?: (value: number) => string;
  compact?: boolean;
  full?: boolean;
  children: ReactNode;
}) {
  const className = [
    styles.overviewRealtimeCard,
    'keeper-card-surface',
    compact ? styles.overviewRealtimeCardCompact : '',
    full ? styles.overviewRealtimeCardFull : '',
  ].filter(Boolean).join(' ');
  return (
    <section className={className}>
      <div className={styles.overviewRealtimeCardHeader}>
        <div className="keeper-card-title-track"><h3 className="keeper-card-title">{title}</h3></div>
        {summary && formatter && <MetricChips summary={summary} formatter={formatter} />}
      </div>
      {children}
    </section>
  );
}

function ChartFrame({ loading, empty, children }: { loading: boolean; empty?: string; children: ReactNode }) {
  return (
    <div className={styles.overviewRealtimeChartFrame} aria-busy={loading}>
      {children}
      {empty && <div className={styles.overviewRealtimeEmptyOverlay} role="status"><span>{empty}</span></div>}
    </div>
  );
}

export function OverviewRangeMetricsPanel({ usage, analysis, latency, loading, analysisLoading, latencyLoading, analysisError, latencyError, isDark, isMobile }: OverviewRangeMetricsPanelProps) {
  const { t } = useTranslation();
  const [activeDimension, setActiveDimension] = useState<RangeDimensionKey>('models');
  const series = usage?.series;
  const labels = useMemo(() => (series?.buckets ?? []).map((bucket) => formatBucket(bucket, usage?.timezone)), [series?.buckets, usage?.timezone]);
  const tpm = series?.tpm ?? [];
  const rpm = series?.rpm ?? [];
  const cacheRates = series?.cache_read_rate ?? [];
  const tokenSummary = summarizeRangeValues(tpm);
  const requestSummary = summarizeRangeValues(rpm);
  const cacheSummary = summarizeRangeValues(cacheRates);
  const ttftValues = useMemo(() => (latency?.points ?? []).map((point) => point.ttft_ms).filter((value) => value > 0), [latency?.points]);
  const latencyValues = useMemo(() => (latency?.points ?? []).map((point) => point.latency_ms).filter((value) => value > 0), [latency?.points]);
  const ttftSummary = useMemo(() => ({ ...summarizeRangeValues(ttftValues), p95: latency?.p95_ttft_ms || null, maximum: latency?.max_ttft_ms || null }), [latency?.max_ttft_ms, latency?.p95_ttft_ms, ttftValues]);
  const latencySummary = useMemo(() => ({ ...summarizeRangeValues(latencyValues), p95: latency?.p95_latency_ms || null, maximum: latency?.max_latency_ms || null }), [latency?.max_latency_ms, latency?.p95_latency_ms, latencyValues]);
  const ttftHistogram = useMemo(() => buildDurationHistogram(ttftValues), [ttftValues]);
  const latencyHistogram = useMemo(() => buildDurationHistogram(latencyValues), [latencyValues]);
  const durationFormatter = (value: number) => formatDurationMs(value, { maxUnits: 2, locale: 'en-US', unitLabels: DURATION_UNITS });
  const lineOptions = useMemo(() => buildLineOptions(isDark, isMobile, formatCompactNumber), [isDark, isMobile]);
  const requestOptions = useMemo(() => buildLineOptions(isDark, isMobile, formatPerMinuteValue), [isDark, isMobile]);
  const cacheOptions = useMemo(() => buildLineOptions(isDark, isMobile, (value) => `${formatFixedTwoDecimals(value)}%`), [isDark, isMobile]);
  const barOptions = useMemo(() => buildBarOptions(isDark, isMobile), [isDark, isMobile]);
  const dimensions = useMemo(() => [
    { key: 'models' as const, label: t('usage_stats.overview_realtime_dimension_models'), items: analysis?.model_composition ?? [] },
    { key: 'api_keys' as const, label: t('usage_stats.overview_realtime_dimension_api_keys'), items: analysis?.api_key_composition ?? [] },
    { key: 'auth_files' as const, label: t('usage_stats.overview_realtime_dimension_auth_files'), items: analysis?.auth_files_composition ?? [] },
    { key: 'ai_providers' as const, label: t('usage_stats.overview_realtime_dimension_ai_providers'), items: analysis?.ai_provider_composition ?? [] },
  ], [analysis, t]);
  const activeItems = dimensions.find((dimension) => dimension.key === activeDimension)?.items ?? [];
  const unsupportedLatency = latency?.supported === false;

  if (loading && !usage) {
    return <div className={styles.overviewRealtimeLoading} aria-busy="true"><LoadingSpinner size={18} /><span>{t('common.loading')}</span></div>;
  }

  const renderCompositionItem = (item: AnalysisCompositionItem) => (
    <div key={item.key} className={styles.overviewRealtimeUsageItem}>
      <div className={styles.overviewRealtimeUsageTopline}>
        <span className={styles.overviewRealtimeUsageLabel} title={item.label}>{item.label}</span>
        <span className={styles.overviewRealtimeUsageShare}>{formatFixedTwoDecimals(item.percent)}%</span>
      </div>
      <div className={styles.overviewRealtimeUsageTrack}><span className={styles.overviewRealtimeUsageBar} style={{ width: `${Math.max(0, Math.min(100, item.percent))}%` }} /></div>
      <div className={styles.overviewRealtimeUsageMeta}>
        <span className={styles.overviewRealtimeUsageMetaPill}>{t('usage_stats.overview_realtime_tokens_label')} <span className={styles.overviewRealtimeUsageMetaValue}>{formatCompactNumber(item.total_tokens)}</span></span>
        <span className={styles.overviewRealtimeUsageMetaPill}>{t('usage_stats.overview_realtime_requests_label')} <span className={styles.overviewRealtimeUsageMetaValue}>{item.requests.toLocaleString()}</span></span>
        {item.cost_available && <span className={styles.overviewRealtimeUsageMetaPill}>{t('usage_stats.overview_realtime_cost_label')} <span className={styles.overviewRealtimeUsageMetaValue}>{formatUsd(item.cost_usd)}</span></span>}
      </div>
    </div>
  );

  return (
    <div className={styles.overviewRealtimeSection}>
      <div className={styles.overviewRealtimeToolbar}><div className={styles.overviewRealtimeHeading}><h2 className={styles.overviewRealtimeTitle}>{t('usage_stats.overview_range_section_title')}</h2></div></div>
      {analysisError && <div className={styles.errorBox}>{analysisError}</div>}
      {latencyError && <div className={styles.errorBox}>{latencyError}</div>}
      <div className={styles.overviewRealtimeGrid}>
        <RangeCard title={t('usage_stats.overview_realtime_token_velocity')} summary={tokenSummary} formatter={(value) => `${formatCompactNumber(value)}/min`} full>
          <ChartFrame loading={loading} empty={tpm.length === 0 ? t('usage_stats.overview_realtime_token_empty') : undefined}>
            <Line data={buildLineData(labels, tpm, t('usage_stats.overview_realtime_tpm'), COLORS.token)} options={lineOptions} />
          </ChartFrame>
        </RangeCard>
        <div className={styles.overviewRealtimeResponseUsageRow}>
          <div className={styles.overviewRealtimeResponseStack}>
            <RangeCard title={t('usage_stats.overview_realtime_ttft_distribution')} summary={ttftSummary} formatter={durationFormatter} compact>
              <ChartFrame loading={latencyLoading} empty={unsupportedLatency ? t('usage_stats.analysis_latency_recent_range_only') : ttftHistogram.counts.length === 0 ? t('usage_stats.overview_realtime_ttft_empty') : undefined}>
                <Bar data={{ labels: ttftHistogram.labels, datasets: [{ label: t('usage_stats.overview_realtime_ttft_distribution'), data: ttftHistogram.counts, backgroundColor: `${COLORS.ttft}99` }] }} options={barOptions} />
              </ChartFrame>
            </RangeCard>
            <RangeCard title={t('usage_stats.overview_realtime_latency_distribution')} summary={latencySummary} formatter={durationFormatter} compact>
              <ChartFrame loading={latencyLoading} empty={unsupportedLatency ? t('usage_stats.analysis_latency_recent_range_only') : latencyHistogram.counts.length === 0 ? t('usage_stats.overview_realtime_latency_empty') : undefined}>
                <Bar data={{ labels: latencyHistogram.labels, datasets: [{ label: t('usage_stats.overview_realtime_latency_distribution'), data: latencyHistogram.counts, backgroundColor: `${COLORS.latency}99` }] }} options={barOptions} />
              </ChartFrame>
            </RangeCard>
          </div>
          <RangeCard title={t('usage_stats.overview_realtime_current_usage')}>
            <div className={styles.overviewRealtimeDimensionTabs}>
              {dimensions.map((dimension) => <button key={dimension.key} type="button" className={`${styles.overviewRealtimeDimensionTab} ${activeDimension === dimension.key ? styles.overviewRealtimeDimensionTabActive : ''}`.trim()} onClick={() => setActiveDimension(dimension.key)} aria-pressed={activeDimension === dimension.key}>{dimension.label}</button>)}
            </div>
            <div className={styles.overviewRealtimeUsageList} aria-busy={analysisLoading}>
              {activeItems.length === 0 ? <div className={styles.overviewRealtimeEmpty}>{t('usage_stats.overview_realtime_usage_empty')}</div> : activeItems.slice(0, 5).map(renderCompositionItem)}
            </div>
          </RangeCard>
        </div>
        <RangeCard title={t('usage_stats.overview_realtime_request_level')} summary={requestSummary} formatter={formatPerMinuteValue}>
          <ChartFrame loading={loading} empty={rpm.length === 0 ? t('usage_stats.overview_realtime_request_empty') : undefined}>
            <Line data={buildLineData(labels, rpm, t('usage_stats.overview_realtime_rpm'), COLORS.request)} options={requestOptions} />
          </ChartFrame>
        </RangeCard>
        <RangeCard title={t('usage_stats.overview_realtime_cache_level')} summary={cacheSummary} formatter={(value) => `${formatFixedTwoDecimals(value)}%`}>
          <ChartFrame loading={loading} empty={finiteValues(cacheRates).length === 0 ? t('usage_stats.overview_realtime_cache_empty') : undefined}>
            <Line data={buildLineData(labels, cacheRates.map((value) => value ?? 0), t('usage_stats.overview_realtime_cache_rate'), COLORS.cache)} options={cacheOptions} />
          </ChartFrame>
        </RangeCard>
      </div>
    </div>
  );
}
