/**
 * Oracle Push Service
 * Pushes aggregated prices to the on-chain HubOracle contract.
 */
import { execFileSync } from 'child_process';
import { logger } from '../utils/logger';
import { config } from '../config';
import { AggregatedPrice } from '../types';

export class OraclePushService {
  private contractId: string;
  private rpcUrl: string;
  private networkPassphrase: string;
  private adminSecret: string;
  private pushCount: number = 0;
  private lastPushAt: Date | null = null;
  private lastPushError: string | null = null;

  constructor() {
    this.contractId = config.oracleContractId;
    this.rpcUrl = config.oracleRpcUrl;
    this.networkPassphrase = config.oracleNetworkPassphrase;
    this.adminSecret = config.oracleAdminSecret;

    if (!this.contractId || !this.adminSecret) {
      logger.warn('Oracle push not configured — ORACLE_CONTRACT_ID and ORACLE_ADMIN_SECRET required');
    }
  }

  isConfigured(): boolean {
    return !!(this.contractId && this.adminSecret && this.rpcUrl);
  }

  /**
   * Push the current price to the on-chain oracle contract.
   * Price is scaled to 7 decimals (i128).
   */
  async pushPrice(price: AggregatedPrice): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.debug('Oracle push not configured, skipping');
      return false;
    }

    try {
      const priceScaled = Math.round(price.price_usd * 1e7);
      const confidence = Math.round(price.confidence_score * 100);

      const args = [
        'contract', 'invoke',
        '--id', this.contractId,
        '--rpc-url', this.rpcUrl,
        '--network-passphrase', this.networkPassphrase,
        '--source-account', this.adminSecret,
        '--inclusion-fee', '1000000',
        '--',
        'set_price',
        '--admin', this.adminSecret,
        '--asset', this.contractId,
        '--price', String(priceScaled),
        '--decimals', '7',
        '--confidence', String(confidence),
      ];

      logger.debug('Pushing price to on-chain oracle', {
        price_usd: price.price_usd,
        price_scaled: priceScaled,
        confidence,
        sources: price.sources_used,
      });

      execFileSync('soroban', args, {
        timeout: 30000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.pushCount++;
      this.lastPushAt = new Date();
      this.lastPushError = null;

      logger.info('Price pushed to on-chain oracle', {
        price_usd: price.price_usd,
        push_count: this.pushCount,
      });

      return true;
    } catch (error: any) {
      this.lastPushError = error.message;
      logger.error('Failed to push price to on-chain oracle', {
        error: error.message,
        price_usd: price.price_usd,
      });
      return false;
    }
  }

  getStats() {
    return {
      configured: this.isConfigured(),
      push_count: this.pushCount,
      last_push_at: this.lastPushAt,
      last_push_error: this.lastPushError,
      contract_id: this.contractId || null,
    };
  }
}
