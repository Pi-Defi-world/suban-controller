/**
 * TWAP and volatility from persisted price observations.
 *
 * The calculation is intentionally pure and deterministic: callers pass the
 * observations and the window, so a result can be reproduced from the SQLite
 * rows without depending on wall-clock time or live sources.
 *
 * Method: `twap_volatility_v1`
 * - TWAP is the time-weighted average of observation prices. A price is held
 *   until the next observation (or until `asOfMs` for the last observation).
 * - Volatility is the sample standard deviation of consecutive log returns,
 *   annualised with the average observation interval. It is `null` when fewer
 *   than two returns exist; we never substitute zero for missing evidence.
 */
export const PRICE_STATS_METHOD_VERSION = 'twap_volatility_v1';
export const MAX_WINDOW_SECONDS = 30 * 86_400;
export const MIN_WINDOW_SECONDS = 60;
const SECONDS_PER_YEAR = 365 * 86_400;

export interface PricePoint {
  price: number;
  observed_at: number;
}

export interface PriceStatistics {
  method_version: string;
  window_seconds: number;
  as_of_ms: number;
  sample_count: number;
  first_observed_at_ms: number;
  last_observed_at_ms: number;
  coverage_seconds: number;
  coverage_ratio: number;
  twap_usd: number;
  min_price_usd: number;
  max_price_usd: number;
  change_pct: number;
  realized_volatility: number | null;
  annualized_volatility: number | null;
  returns_count: number;
  warnings: string[];
}

export interface ParsedWindow {
  seconds: number;
  label: string;
}

/** Parse `5m`, `24h`, `30d`, or a plain number of seconds. */
export function parseWindow(raw: unknown, fallbackSeconds = 86_400): ParsedWindow | null {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!text) {
    return { seconds: fallbackSeconds, label: labelForSeconds(fallbackSeconds) };
  }

  const match = /^(\d+)\s*(s|m|h|d)?$/.exec(text);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2] || 's';
  const multiplier = unit === 'd' ? 86_400 : unit === 'h' ? 3_600 : unit === 'm' ? 60 : 1;
  const seconds = value * multiplier;

  if (!Number.isFinite(seconds) || seconds < MIN_WINDOW_SECONDS || seconds > MAX_WINDOW_SECONDS) {
    return null;
  }
  return {
    seconds,
    label: match[2] ? `${value}${unit}` : labelForSeconds(seconds),
  };
}

/** Parse an ISO-8601 timestamp, epoch seconds or epoch milliseconds. */
export function parseAsOf(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1_000_000_000_000 ? Math.floor(raw) : Math.floor(raw * 1_000);
  }
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    return numeric > 1_000_000_000_000 ? numeric : numeric * 1_000;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function computePriceStatistics(
  points: PricePoint[],
  windowSeconds: number,
  asOfMs: number
): PriceStatistics | null {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0 || !Number.isFinite(asOfMs)) {
    return null;
  }

  const startMs = asOfMs - windowSeconds * 1_000;
  const windowPoints = points
    .filter(
      (point) =>
        Number.isFinite(point.price) &&
        point.price > 0 &&
        Number.isFinite(point.observed_at) &&
        point.observed_at >= startMs &&
        point.observed_at <= asOfMs
    )
    .sort((a, b) => a.observed_at - b.observed_at);

  if (windowPoints.length === 0) return null;

  let weightedPrice = 0;
  let totalWeight = 0;
  for (let index = 0; index < windowPoints.length; index += 1) {
    const point = windowPoints[index];
    const segmentStart = Math.max(point.observed_at, startMs);
    const segmentEnd =
      index + 1 < windowPoints.length ? windowPoints[index + 1].observed_at : asOfMs;
    const seconds = Math.max(0, (segmentEnd - segmentStart) / 1_000);
    weightedPrice += point.price * seconds;
    totalWeight += seconds;
  }

  // Multiple observations can share a timestamp (for example after a replay).
  // In that case time-weighting has no duration, so fall back to the simple
  // mean of the observations rather than inventing a time span.
  const twap =
    totalWeight > 0
      ? weightedPrice / totalWeight
      : windowPoints.reduce((sum, point) => sum + point.price, 0) / windowPoints.length;

  const prices = windowPoints.map((point) => point.price);
  const first = windowPoints[0];
  const last = windowPoints[windowPoints.length - 1];
  const warnings: string[] = [];

  if (windowPoints.length === 1) {
    warnings.push('single observation; volatility is unavailable');
  }
  if (totalWeight > 0 && totalWeight < windowSeconds) {
    warnings.push('partial window coverage');
  }

  const logReturns: Array<{ value: number; seconds: number }> = [];
  for (let index = 1; index < windowPoints.length; index += 1) {
    const previous = windowPoints[index - 1];
    const current = windowPoints[index];
    const seconds = (current.observed_at - previous.observed_at) / 1_000;
    if (seconds <= 0 || previous.price <= 0 || current.price <= 0) continue;
    logReturns.push({
      value: Math.log(current.price / previous.price),
      seconds,
    });
  }

  let realizedVolatility: number | null = null;
  let annualizedVolatility: number | null = null;
  if (logReturns.length >= 2) {
    const mean = logReturns.reduce((sum, entry) => sum + entry.value, 0) / logReturns.length;
    const variance =
      logReturns.reduce((sum, entry) => sum + (entry.value - mean) ** 2, 0) /
      (logReturns.length - 1);
    realizedVolatility = Math.sqrt(Math.max(0, variance));
    const averageIntervalSeconds =
      logReturns.reduce((sum, entry) => sum + entry.seconds, 0) / logReturns.length;
    annualizedVolatility =
      averageIntervalSeconds > 0
        ? realizedVolatility * Math.sqrt(SECONDS_PER_YEAR / averageIntervalSeconds)
        : null;
  }

  return {
    method_version: PRICE_STATS_METHOD_VERSION,
    window_seconds: windowSeconds,
    as_of_ms: asOfMs,
    sample_count: windowPoints.length,
    first_observed_at_ms: first.observed_at,
    last_observed_at_ms: last.observed_at,
    coverage_seconds: Math.round(totalWeight),
    coverage_ratio: Math.min(1, totalWeight / windowSeconds),
    twap_usd: twap,
    min_price_usd: Math.min(...prices),
    max_price_usd: Math.max(...prices),
    change_pct: ((last.price - first.price) / first.price) * 100,
    realized_volatility: realizedVolatility,
    annualized_volatility: annualizedVolatility,
    returns_count: logReturns.length,
    warnings,
  };
}

function labelForSeconds(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
