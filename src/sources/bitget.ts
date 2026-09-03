/**
 * Bitget exchange connector
 * Uses public API, no authentication required for price data
 * Pi Network is listed as PIUSDT_SPBL
 */
import axios from 'axios';
import { PriceSource, PriceData, SourceError } from '../types';
import { logger } from '../utils/logger';

export class BitgetSource extends PriceSource {
  private baseUrl = 'https://api.bitget.com/api/v2/mix/market';

  async fetchPrice(): Promise<PriceData> {
    const startTime = Date.now();
    
    try {
      const url = `${this.baseUrl}/symbol-price`;
      
      logger.debug('Fetching price from Bitget', { symbol: this.symbol });
      
      const response = await axios.get(url, {
        params: {
          productType: 'usdt-futures',
          symbol: this.symbol,
        },
        timeout: 5000,
      });

      if (!response.data || response.data.code !== '00000' || !Array.isArray(response.data.data) || response.data.data.length === 0) {
        throw new SourceError('Invalid response from Bitget', this.name);
      }

      const price = parseFloat(response.data.data[0].price);
      const timestamp = new Date();

      if (!price || isNaN(price)) {
        throw new SourceError('Invalid price data from Bitget', this.name);
      }

      const responseTime = Date.now() - startTime;
      this.recordSuccess(responseTime);

      logger.info('Bitget price fetched', { price, responseTime });

      return {
        price,
        timestamp,
        source: this.name,
        weight: this.weight,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.recordError(errorMessage);
      logger.error('Bitget fetch error', { 
        error: errorMessage,
        symbol: this.symbol 
      });
      throw new SourceError(`Bitget error: ${errorMessage}`, this.name);
    }
  }
}

