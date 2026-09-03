import { EventEmitter } from 'events';
import axios from 'axios';
import { logger } from '../utils/logger';

const HORIZON_API = 'https://api.mainnet.minepi.com';
const POLL_INTERVAL_MS = parseInt(process.env.TX_STREAM_POLL_MS || '15000', 10);
const BUFFER_SIZE = parseInt(process.env.TX_STREAM_BUFFER_SIZE || '100', 10);
const MAX_BACKOFF_MS = 120_000;

interface HorizonRecord {
  id?: string;
  hash?: string;
  [key: string]: unknown;
}

interface StreamData {
  transactions: HorizonRecord[];
  trades: HorizonRecord[];
  orders: HorizonRecord[];
  updatedAt: string;
}

export class TransactionStreamer extends EventEmitter {
  private transactions: HorizonRecord[] = [];
  private trades: HorizonRecord[] = [];
  private orders: HorizonRecord[] = [];
  private knownTxHashes = new Set<string>();
  private knownTradeIds = new Set<string>();
  private knownOfferIds = new Set<string>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private backoffMs = 0;
  private consecutive429s = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('TransactionStreamer started', { pollIntervalMs: POLL_INTERVAL_MS });
    this.poll();
    this.interval = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    logger.info('TransactionStreamer stopped');
  }

  getSnapshot(): StreamData {
    return {
      transactions: this.transactions,
      trades: this.trades,
      orders: this.orders,
      updatedAt: new Date().toISOString(),
    };
  }

  private async poll(): Promise<void> {
    if (this.backoffMs > 0) {
      logger.warn('TransactionStreamer backing off', { backoffMs: this.backoffMs, consecutive429s: this.consecutive429s });
      await new Promise((r) => setTimeout(r, this.backoffMs));
      this.backoffMs = Math.max(0, this.backoffMs - 5000);
      if (this.backoffMs === 0) this.consecutive429s = 0;
    }

    let rateLimited = false;
    try {
      await this.fetchTransactions();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('429')) rateLimited = true;
    }
    try {
      await this.fetchTrades();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('429')) rateLimited = true;
    }
    try {
      await this.fetchOrders();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('429')) rateLimited = true;
    }

    if (rateLimited) {
      this.consecutive429s++;
      this.backoffMs = Math.min(MAX_BACKOFF_MS, (this.consecutive429s * 5000));
      logger.warn('TransactionStreamer rate limited, backing off', { backoffMs: this.backoffMs });
    }
  }

  private async fetchWithBackoff(url: string, params: Record<string, unknown>): Promise<HorizonRecord[]> {
    const { data } = await axios.get(url, { params, timeout: 8000 });
    return data._embedded?.records ?? [];
  }

  private async fetchTransactions(): Promise<void> {
    try {
      const records = await this.fetchWithBackoff(`${HORIZON_API}/transactions`, { order: 'desc', limit: 20 });
      let hasNew = false;

      for (const tx of records) {
        const id = (tx.hash || tx.id) as string;
        if (id && !this.knownTxHashes.has(id)) {
          this.knownTxHashes.add(id);
          this.transactions.unshift(tx);
          hasNew = true;
        }
      }

      if (this.transactions.length > BUFFER_SIZE) {
        const removed = this.transactions.splice(BUFFER_SIZE);
        for (const tx of removed) {
          const id = tx.hash || tx.id;
          if (id) this.knownTxHashes.delete(id as string);
        }
      }

      if (hasNew) {
        this.emit('transactions', this.transactions.slice(0, 20));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('TransactionStreamer fetchTransactions error', { error: msg });
      throw error;
    }
  }

  private async fetchTrades(): Promise<void> {
    try {
      const records = await this.fetchWithBackoff(`${HORIZON_API}/trades`, { order: 'desc', limit: 20 });
      let hasNew = false;

      for (const trade of records) {
        const id = (trade.id) as string;
        if (id && !this.knownTradeIds.has(id)) {
          this.knownTradeIds.add(id);
          this.trades.unshift(trade);
          hasNew = true;
        }
      }

      if (this.trades.length > BUFFER_SIZE) {
        const removed = this.trades.splice(BUFFER_SIZE);
        for (const tr of removed) {
          const id = tr.id;
          if (id) this.knownTradeIds.delete(id as string);
        }
      }

      if (hasNew) {
        this.emit('trades', this.trades.slice(0, 20));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('TransactionStreamer fetchTrades error', { error: msg });
      throw error;
    }
  }

  private async fetchOrders(): Promise<void> {
    try {
      const records = await this.fetchWithBackoff(`${HORIZON_API}/offers`, { order: 'desc', limit: 20 });
      let hasNew = false;

      for (const offer of records) {
        const id = (offer.id) as string;
        if (id && !this.knownOfferIds.has(id)) {
          this.knownOfferIds.add(id);
          this.orders.unshift(offer);
          hasNew = true;
        }
      }

      if (this.orders.length > BUFFER_SIZE) {
        const removed = this.orders.splice(BUFFER_SIZE);
        for (const o of removed) {
          const id = o.id;
          if (id) this.knownOfferIds.delete(id as string);
        }
      }

      if (hasNew) {
        this.emit('orders', this.orders.slice(0, 20));
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('TransactionStreamer fetchOrders error', { error: msg });
      throw error;
    }
  }
}
