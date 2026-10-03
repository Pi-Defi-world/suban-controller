/**
 * Arc price source connector
 * Queries Arc chain for token prices via JSON-RPC or REST API.
 * Arc is Circle's stablecoin-native L1 with institutional validators.
 */
import axios from 'axios';
import { PriceSource, PriceData, SourceError } from '../types';
import { logger } from '../utils/logger';

export class ArcSource extends PriceSource {
  private rpcUrl: string;
  private pairAddress: string;

  constructor(name: string, weight: number, symbol: string, rpcUrl: string, pairAddress: string = '') {
    super(name, weight, symbol);
    this.rpcUrl = rpcUrl;
    this.pairAddress = pairAddress;
  }

  async fetchPrice(): Promise<PriceData> {
    const startTime = Date.now();

    try {
      logger.debug('Fetching price from Arc', { symbol: this.symbol, rpc: this.rpcUrl });

      // First verify Arc RPC is reachable
      const blockResponse = await axios.post(this.rpcUrl, {
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1,
      }, { timeout: 5000 });

      if (!blockResponse.data?.result) {
        throw new SourceError('Arc RPC returned invalid response', this.name);
      }

      // If we have a pair address, query the AMM pool for price
      if (this.pairAddress) {
        // balanceOf(address) = 0x70a08231
        // getReserves() = 0x0902f1ac
        const reserveResponse = await axios.post(this.rpcUrl, {
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{
            to: this.pairAddress,
            data: '0x0902f1ac', // getReserves()
          }, 'latest'],
          id: 2,
        }, { timeout: 5000 });

        if (reserveResponse.data?.result) {
          const result = reserveResponse.data.result;
          // Decode reserves (two uint112 values + uint32 blockTimestampLast)
          // First 64 hex chars (32 bytes) = reserve0, next 64 = reserve1
          const reserve0 = BigInt('0x' + result.slice(2, 66));
          const reserve1 = BigInt('0x' + result.slice(66, 130));

          // Assuming reserve0 = USDC (6 decimals), reserve1 = PI (varies)
          // Price = reserve0 / reserve1 (adjusted for decimals)
          if (reserve1 > 0n) {
            const price = Number(reserve0) / Number(reserve1);
            const responseTime = Date.now() - startTime;
            this.recordSuccess(responseTime);

            logger.info('Arc AMM price fetched', { price, responseTime, pair: this.pairAddress });

            return {
              price,
              timestamp: new Date(),
              source: this.name,
              weight: this.weight,
            };
          }
        }
      }

      // Fallback: Arc RPC is reachable but no price data available
      throw new SourceError('Arc price data not available (no AMM pool configured)', this.name);

    } catch (error: any) {
      const errorMessage = error.response?.data?.error?.message || error.message;
      this.recordError(errorMessage);
      logger.error('Arc fetch error', {
        error: errorMessage,
        symbol: this.symbol,
      });
      throw new SourceError(`Arc error: ${errorMessage}`, this.name);
    }
  }
}
