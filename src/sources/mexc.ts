/**
 * MEXC exchange connector — public API, no key required.
 */
import axios from 'axios';
import { PriceSource, PriceData, SourceError } from '../types';
import { logger } from '../utils/logger';

export class MexcSource extends PriceSource {
  private baseUrl = 'https://api.mexc.com/api/v3';

  async fetchPrice(): Promise<PriceData> {
    const startTime = Date.now();

    try {
      const url = `${this.baseUrl}/ticker/price`;

      logger.debug('Fetching price from MEXC', { symbol: this.symbol });

      const response = await axios.get(url, {
        params: { symbol: this.symbol },
        timeout: 10000,
      });

      const price = parseFloat(response.data?.price);
      if (!price || isNaN(price)) {
        throw new SourceError('Invalid price data from MEXC', this.name);
      }

      const responseTime = Date.now() - startTime;
      this.recordSuccess(responseTime);

      logger.info('MEXC price fetched', { price, responseTime });

      return {
        price,
        timestamp: new Date(),
        source: this.name,
        weight: this.weight,
      };
    } catch (error: any) {
      const errorMessage = error.response?.data?.msg || error.message;
      this.recordError(errorMessage);
      logger.error('MEXC fetch error', {
        error: errorMessage,
        symbol: this.symbol,
      });
      throw new SourceError(`MEXC error: ${errorMessage}`, this.name);
    }
  }
}
