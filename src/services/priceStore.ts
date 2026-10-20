/**
 * Durable price observation store (SQLite).
 *
 * Observations are append-only and pruned by age. Reads are bounded so a
 * caller cannot accidentally scan the whole retention window.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface PriceObservationInput {
  symbol: string;
  price: number;
  confidence: number;
  sourcesUsed: number;
  trustState: string;
  observedAt?: number;
}

export interface PriceObservation {
  id: number;
  symbol: string;
  price: number;
  confidence: number;
  sources_used: number;
  trust_state: string;
  observed_at: number;
}

export interface PriceStats {
  high24h: number;
  low24h: number;
  open24h: number;
  closePrice: number;
  count: number;
}

export interface PriceRecorder {
  record(observation: PriceObservationInput): void;
}

const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 86_400_000;

export class PriceStore implements PriceRecorder {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly retentionMs: number;
  private lastPruneAt = 0;

  constructor(dbPath: string, retentionDays: number = 30) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS price_observations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol       TEXT    NOT NULL,
        price        REAL    NOT NULL,
        confidence   REAL    NOT NULL,
        sources_used INTEGER NOT NULL,
        trust_state  TEXT    NOT NULL,
        observed_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_price_observed_at
        ON price_observations (observed_at);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO price_observations
        (symbol, price, confidence, sources_used, trust_state, observed_at)
      VALUES
        (@symbol, @price, @confidence, @sourcesUsed, @trustState, @observedAt)
    `);
    this.deleteStmt = this.db.prepare(
      'DELETE FROM price_observations WHERE observed_at < ?'
    );
    this.retentionMs = Math.max(1, retentionDays) * ONE_DAY_MS;
  }

  record(observation: PriceObservationInput): void {
    const observedAt = observation.observedAt ?? Date.now();
    this.insertStmt.run({
      symbol: observation.symbol,
      price: observation.price,
      confidence: observation.confidence,
      sourcesUsed: observation.sourcesUsed,
      trustState: observation.trustState,
      observedAt,
    });
    this.maybePrune(observedAt);
  }

  /** Newest first. */
  getHistory(options: { sinceMs?: number; limit?: number } = {}): PriceObservation[] {
    const sinceMs = options.sinceMs ?? Date.now() - ONE_DAY_MS;
    const limit = Math.max(1, Math.min(options.limit ?? 1000, 10_000));
    return this.db
      .prepare(
        `SELECT id, symbol, price, confidence, sources_used, trust_state, observed_at
           FROM price_observations
          WHERE observed_at >= ?
          ORDER BY observed_at DESC
          LIMIT ?`
      )
      .all(sinceMs, limit) as PriceObservation[];
  }

  getStats(sinceMs?: number): PriceStats | null {
    const cutoff = sinceMs ?? Date.now() - ONE_DAY_MS;
    // Breaker observations are kept for audit but excluded from public stats.
    const aggregate = this.db
      .prepare(
        `SELECT MIN(price) AS low, MAX(price) AS high, COUNT(*) AS count
           FROM price_observations
          WHERE observed_at >= ? AND trust_state != 'BREAKER'`
      )
      .get(cutoff) as { low: number | null; high: number | null; count: number };

    if (aggregate.count === 0 || aggregate.low === null || aggregate.high === null) {
      return null;
    }

    const open = this.db
      .prepare(
        `SELECT price
           FROM price_observations
          WHERE observed_at >= ? AND trust_state != 'BREAKER'
          ORDER BY observed_at ASC
          LIMIT 1`
      )
      .get(cutoff) as { price: number };
    const close = this.db
      .prepare(
        `SELECT price
           FROM price_observations
          WHERE observed_at >= ? AND trust_state != 'BREAKER'
          ORDER BY observed_at DESC
          LIMIT 1`
      )
      .get(cutoff) as { price: number };

    return {
      high24h: aggregate.high,
      low24h: aggregate.low,
      open24h: open.price,
      closePrice: close.price,
      count: aggregate.count,
    };
  }

  prune(nowMs: number = Date.now()): number {
    const result = this.deleteStmt.run(nowMs - this.retentionMs);
    this.lastPruneAt = nowMs;
    return result.changes;
  }

  count(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM price_observations')
      .get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }

  private maybePrune(nowMs: number): void {
    if (nowMs - this.lastPruneAt < ONE_HOUR_MS) {
      return;
    }
    try {
      const removed = this.prune(nowMs);
      if (removed > 0) {
        logger.debug('Pruned old price observations', { removed });
      }
    } catch (error) {
      // Persistence must never break price serving.
      logger.warn('Failed to prune price observations', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

let instance: PriceStore | null = null;

/** Lazily opens the database so importing modules has no side effects. */
export function getPriceStore(): PriceStore {
  if (instance === null) {
    instance = new PriceStore(config.priceDbPath, config.priceRetentionDays);
  }
  return instance;
}

export function closePriceStore(): void {
  if (instance !== null) {
    instance.close();
    instance = null;
  }
}
