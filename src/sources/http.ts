/**
 * Generic JSON-over-HTTP price source.
 *
 * Used for assets that do not have a public exchange/CoinGecko listing. The
 * endpoint and JSON path are configured per asset; if they are unset the asset
 * is not enabled rather than being priced from an invented peg.
 */
import axios from 'axios';
import { PriceData, PriceSource, SourceError } from '../types';
import { logger } from '../utils/logger';

export class HttpPriceSource extends PriceSource {
  constructor(
    name: string,
    weight: number,
    private readonly url: string,
    private readonly jsonPath: string = 'price'
  ) {
    super(name, weight, url);
  }

  async fetchPrice(): Promise<PriceData> {
    const startTime = Date.now();

    try {
      const response = await axios.get(this.url, {
        timeout: 10_000,
        headers: { Accept: 'application/json' },
      });

      const raw = this.jsonPath
        .split('.')
        .reduce<unknown>((value, key) => {
          if (value && typeof value === 'object') {
            return (value as Record<string, unknown>)[key];
          }
          return undefined;
        }, response.data);

      const price = typeof raw === 'string' ? parseFloat(raw) : raw;
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
        throw new SourceError(
          `Invalid price at JSON path "${this.jsonPath}"`,
          this.name
        );
      }

      const responseTime = Date.now() - startTime;
      this.recordSuccess(responseTime);
      logger.info('HTTP price fetched', {
        source: this.name,
        price,
        responseTime,
      });

      return {
        price,
        timestamp: new Date(),
        source: this.name,
        weight: this.weight,
      };
    } catch (error) {
      const message =
        axios.isAxiosError(error)
          ? error.response?.data?.error || error.message
          : error instanceof Error
            ? error.message
            : String(error);
      this.recordError(message);
      logger.error('HTTP price fetch error', { source: this.name, error: message });
      throw new SourceError(`HTTP price error: ${message}`, this.name);
    }
  }
}
