/**
 * Prometheus metrics for the controller.
 *
 * Kept in one module so every service uses the same registry and so tests can
 * reset it if needed.
 */
import type { NextFunction, Request, Response } from 'express';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

export const priceGauge = new Gauge({
  name: 'suban_price_usd',
  help: 'Latest aggregated price in USD',
  labelNames: ['symbol'],
  registers: [metricsRegistry],
});

export const priceConfidenceGauge = new Gauge({
  name: 'suban_price_confidence',
  help: 'Confidence score of the latest aggregation (0-1)',
  labelNames: ['symbol'],
  registers: [metricsRegistry],
});

export const priceAgeGauge = new Gauge({
  name: 'suban_price_age_ms',
  help: 'Age of the latest aggregation in milliseconds',
  labelNames: ['symbol'],
  registers: [metricsRegistry],
});

export const sourceUpGauge = new Gauge({
  name: 'suban_source_up',
  help: 'Whether a price source is currently usable (1) or not (0)',
  labelNames: ['source'],
  registers: [metricsRegistry],
});

export const sourceStalenessGauge = new Gauge({
  name: 'suban_source_staleness_ms',
  help: 'Age of the last successful fetch for a source, in milliseconds',
  labelNames: ['source'],
  registers: [metricsRegistry],
});

export const aggregationCounter = new Counter({
  name: 'suban_price_aggregations_total',
  help: 'Aggregation outcomes',
  labelNames: ['result'],
  registers: [metricsRegistry],
});

export const oraclePushCounter = new Counter({
  name: 'suban_oracle_push_total',
  help: 'On-chain oracle push outcomes',
  labelNames: ['result'],
  registers: [metricsRegistry],
});

export const httpRequestsCounter = new Counter({
  name: 'suban_http_requests_total',
  help: 'HTTP requests by method, route and status',
  labelNames: ['method', 'route', 'status'],
  registers: [metricsRegistry],
});

export const TRUST_STATES = ['HEALTHY', 'DEGRADED', 'BREAKER', 'RECOVERY'] as const;
export type TrustStateName = (typeof TRUST_STATES)[number];

export const trustStateGauge = new Gauge({
  name: 'suban_oracle_trust_state',
  help: 'Current oracle trust state (1 for the active state, 0 otherwise)',
  labelNames: ['state'],
  registers: [metricsRegistry],
});

export function setTrustState(state: TrustStateName): void {
  for (const candidate of TRUST_STATES) {
    trustStateGauge.set({ state: candidate }, candidate === state ? 1 : 0);
  }
}

/** Express middleware that records request counts on completion. */
export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    // `req.route` is populated by the time the response finishes.
    const route = req.route?.path ?? req.path;
    httpRequestsCounter.inc({
      method: req.method,
      route,
      status: String(res.statusCode),
    });
  });
  next();
}
