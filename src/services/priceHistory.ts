/**
 * Price history service - in-memory ring buffer for 24h stats
 * No external dependencies (MongoDB not required).
 */
import { logger } from '../utils/logger';

interface PriceObservation {
  price: number;
  timestamp: number;
}

const MAX_OBSERVATIONS = 8640; // 24h at 10s intervals
const MAX_AGE_MS = 86_400_000; // 24 hours

let observations: PriceObservation[] = [];
let lastTrimAt = 0;

export function recordPrice(price: number, _source: string): void {
  observations.push({ price, timestamp: Date.now() });
  if (observations.length > MAX_OBSERVATIONS) {
    observations = observations.slice(-MAX_OBSERVATIONS);
  }
  // Trim old observations every 5 minutes
  if (Date.now() - lastTrimAt > 300_000) {
    trimOldPrices();
    lastTrimAt = Date.now();
  }
}

export function get24hStats(): {
  high24h: number;
  low24h: number;
  open24h: number;
  closePrice: number;
} | null {
  const cutoff = Date.now() - MAX_AGE_MS;
  const recent = observations.filter(o => o.timestamp >= cutoff);
  if (recent.length === 0) return null;

  const prices = recent.map(o => o.price);
  const high24h = Math.max(...prices);
  const low24h = Math.min(...prices);
  const open24h = recent[0].price;
  const closePrice = recent[recent.length - 1].price;

  return { high24h, low24h, open24h, closePrice };
}

function trimOldPrices(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  const before = observations.length;
  observations = observations.filter(o => o.timestamp >= cutoff);
  if (observations.length < before) {
    logger.debug('Trimmed old price observations', { removed: before - observations.length, remaining: observations.length });
  }
}
