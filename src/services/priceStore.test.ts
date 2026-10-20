import fs from 'fs';
import os from 'os';
import path from 'path';
import { PriceStore } from './priceStore';

describe('PriceStore', () => {
  let store: PriceStore;

  beforeEach(() => {
    store = new PriceStore(':memory:', 30);
  });

  afterEach(() => {
    store.close();
  });

  it('persists observations and returns history newest first', () => {
    const base = Date.now();
    store.record({
      symbol: 'PI',
      price: 1,
      confidence: 0.8,
      sourcesUsed: 3,
      trustState: 'HEALTHY',
      observedAt: base - 3_000,
    });
    store.record({
      symbol: 'PI',
      price: 2,
      confidence: 0.9,
      sourcesUsed: 4,
      trustState: 'HEALTHY',
      observedAt: base - 2_000,
    });
    store.record({
      symbol: 'PI',
      price: 3,
      confidence: 0.7,
      sourcesUsed: 2,
      trustState: 'DEGRADED',
      observedAt: base - 1_000,
    });

    const history = store.getHistory({ sinceMs: base - 10_000, limit: 10 });

    expect(history.map((row) => row.price)).toEqual([3, 2, 1]);
    expect(history[0]).toMatchObject({
      symbol: 'PI',
      sources_used: 2,
      trust_state: 'DEGRADED',
    });
  });

  it('computes window stats from the stored observations', () => {
    const base = Date.now();
    for (const [index, price] of [2, 1, 4, 3].entries()) {
      store.record({
        symbol: 'PI',
        price,
        confidence: 0.9,
        sourcesUsed: 3,
        trustState: 'HEALTHY',
        observedAt: base - 4_000 + index * 1_000,
      });
    }

    expect(store.getStats(base - 10_000)).toEqual({
      high24h: 4,
      low24h: 1,
      open24h: 2,
      closePrice: 3,
      count: 4,
    });
  });

  it('returns null stats when the window is empty', () => {
    expect(store.getStats(Date.now() - 1_000)).toBeNull();
  });

  it('excludes breaker observations from stats but keeps them in history', () => {
    const base = Date.now();
    store.record({
      symbol: 'PI',
      price: 1,
      confidence: 0.9,
      sourcesUsed: 3,
      trustState: 'HEALTHY',
      observedAt: base - 3_000,
    });
    store.record({
      symbol: 'PI',
      price: 9,
      confidence: 0.9,
      sourcesUsed: 3,
      trustState: 'BREAKER',
      observedAt: base - 2_000,
    });
    store.record({
      symbol: 'PI',
      price: 2,
      confidence: 0.9,
      sourcesUsed: 3,
      trustState: 'HEALTHY',
      observedAt: base - 1_000,
    });

    expect(store.getStats(base - 10_000)).toEqual({
      high24h: 2,
      low24h: 1,
      open24h: 1,
      closePrice: 2,
      count: 2,
    });
    expect(
      store.getHistory({ sinceMs: base - 10_000 }).map((row) => row.price)
    ).toEqual([2, 9, 1]);
  });

  it('prunes observations older than the retention window', () => {
    const now = Date.now();
    store.record({
      symbol: 'PI',
      price: 1,
      confidence: 0.9,
      sourcesUsed: 3,
      trustState: 'HEALTHY',
      observedAt: now - 40 * 86_400_000,
    });
    expect(store.count()).toBe(1);

    const removed = store.prune(now);

    expect(removed).toBe(1);
    expect(store.count()).toBe(0);
  });

  it('bounds history reads', () => {
    const base = Date.now();
    for (let i = 0; i < 20; i += 1) {
      store.record({
        symbol: 'PI',
        price: i,
        confidence: 0.9,
        sourcesUsed: 3,
        trustState: 'HEALTHY',
        observedAt: base + i,
      });
    }

    expect(store.getHistory({ sinceMs: base - 1, limit: 5 })).toHaveLength(5);
    expect(store.getHistory({ sinceMs: base - 1, limit: 0 })).toHaveLength(1);
  });

  it('preserves history across a database reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suban-prices-'));
    const dbPath = path.join(dir, 'prices.db');
    const observedAt = Date.now();

    const first = new PriceStore(dbPath, 30);
    first.record({
      symbol: 'PI',
      price: 0.42,
      confidence: 0.9,
      sourcesUsed: 4,
      trustState: 'HEALTHY',
      observedAt,
    });
    first.close();

    const second = new PriceStore(dbPath, 30);
    try {
      const history = second.getHistory({ sinceMs: observedAt - 1_000 });
      expect(history).toHaveLength(1);
      expect(history[0].price).toBe(0.42);
    } finally {
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
