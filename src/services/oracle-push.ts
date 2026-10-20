/**
 * Oracle Push Service
 * Pushes aggregated prices to the on-chain HubOracle contract.
 *
 * Uses the Soroban RPC server (not Horizon): build -> prepare -> sign -> send -> poll.
 * Publishing is opt-in via ORACLE_PUSH_ENABLED=true and requires:
 *   ORACLE_CONTRACT_ID, ORACLE_ASSET, ORACLE_ADMIN_SECRET, ORACLE_RPC_URL
 */
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk';
import { logger } from '../utils/logger';
import { config } from '../config';
import { AggregatedPrice } from '../types';
import { oraclePushCounter } from './metrics';

const TX_POLL_INTERVAL_MS = 1_000;
const TX_TIMEOUT_MS = 30_000;

export class OraclePushService {
  private contractId: string;
  private asset: string;
  private rpcUrl: string;
  private networkPassphrase: string;
  private adminSecret: string;
  private decimals: number;
  private enabled: boolean;
  private pushCount: number = 0;
  private lastPushAt: Date | null = null;
  private lastPushError: string | null = null;

  constructor() {
    this.contractId = config.oracleContractId;
    this.asset = config.oracleAsset;
    this.rpcUrl = config.oracleRpcUrl;
    this.networkPassphrase = config.oracleNetworkPassphrase;
    this.adminSecret = config.oracleAdminSecret;
    this.decimals = config.oraclePriceDecimals;
    this.enabled = config.oraclePushEnabled;

    if (!this.enabled) {
      logger.info('Oracle push disabled (set ORACLE_PUSH_ENABLED=true to enable)');
    } else if (!this.isConfigured()) {
      logger.warn(
        'Oracle push enabled but not configured — ORACLE_CONTRACT_ID, ORACLE_ASSET and ORACLE_ADMIN_SECRET are required'
      );
    }
  }

  isConfigured(): boolean {
    return !!(
      this.enabled &&
      this.contractId &&
      this.asset &&
      this.adminSecret &&
      this.rpcUrl
    );
  }

  async pushPrice(price: AggregatedPrice): Promise<boolean> {
    if (!this.isConfigured()) {
      logger.debug('Oracle push not configured or disabled, skipping');
      oraclePushCounter.inc({ result: 'skipped' });
      return false;
    }

    if (price.trust && price.trust.state !== 'HEALTHY') {
      logger.warn('Skipping oracle push: trust state is not HEALTHY', {
        trust_state: price.trust.state,
        reason: price.trust.reason,
      });
      oraclePushCounter.inc({ result: 'untrusted' });
      return false;
    }

    try {
      const sourceKeypair = Keypair.fromSecret(this.adminSecret);
      const server = new rpc.Server(this.rpcUrl, {
        allowHttp: this.rpcUrl.startsWith('http://'),
      });
      const sourceAccount = await server.getAccount(sourceKeypair.publicKey());

      const scaledPrice = this.scalePrice(price.price_usd);
      // The contract stores confidence on a 0-100 scale.
      const confidence = Math.max(
        0,
        Math.min(100, Math.round(price.confidence_score * 100))
      );

      logger.debug('Pushing price to on-chain oracle', {
        price_usd: price.price_usd,
        scaled_price: scaledPrice.toString(),
        decimals: this.decimals,
        confidence,
        asset: this.asset,
      });

      const contract = new Contract(this.contractId);
      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          contract.call(
            'set_price',
            new Address(sourceKeypair.publicKey()).toScVal(),
            new Address(this.asset).toScVal(),
            nativeToScVal(scaledPrice, { type: 'i128' }),
            nativeToScVal(this.decimals, { type: 'u32' }),
            nativeToScVal(confidence, { type: 'u32' })
          )
        )
        .setTimeout(30)
        .build();

      const prepared = await server.prepareTransaction(tx);
      prepared.sign(sourceKeypair);

      const send = await server.sendTransaction(prepared);
      if (send.status !== 'PENDING') {
        throw new Error(
          `Oracle push rejected: status=${send.status}${
            send.errorResult ? ` error=${JSON.stringify(send.errorResult)}` : ''
          }`
        );
      }

      const hash = send.hash;
      const result = await this.waitForTransaction(server, hash);
      if (result.status !== 'SUCCESS') {
        throw new Error(`Oracle push failed on-chain: status=${result.status}`);
      }

      this.pushCount++;
      this.lastPushAt = new Date();
      this.lastPushError = null;
      oraclePushCounter.inc({ result: 'success' });

      logger.info('Price pushed to on-chain oracle', {
        price_usd: price.price_usd,
        push_count: this.pushCount,
        hash,
      });

      return true;
    } catch (error: any) {
      this.lastPushError = error.message || String(error);
      oraclePushCounter.inc({ result: 'failure' });
      logger.error('Failed to push price to on-chain oracle', {
        error: this.lastPushError,
        price_usd: price.price_usd,
      });
      return false;
    }
  }

  private scalePrice(priceUsd: number): bigint {
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw new Error(`Invalid price for oracle push: ${priceUsd}`);
    }
    const factor = 10 ** this.decimals;
    const scaled = Math.round(priceUsd * factor);
    if (!Number.isSafeInteger(scaled)) {
      throw new Error(`Price does not fit safely at ${this.decimals} decimals`);
    }
    return BigInt(scaled);
  }

  private async waitForTransaction(
    server: rpc.Server,
    hash: string
  ): Promise<rpc.Api.GetTransactionResponse> {
    const deadline = Date.now() + TX_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const result = await server.getTransaction(hash);
      if (result.status !== 'NOT_FOUND') {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, TX_POLL_INTERVAL_MS));
    }

    throw new Error(`Timed out waiting for oracle transaction ${hash}`);
  }

  getStats() {
    return {
      configured: this.isConfigured(),
      enabled: this.enabled,
      push_count: this.pushCount,
      last_push_at: this.lastPushAt,
      last_push_error: this.lastPushError,
      contract_id: this.contractId || null,
      asset: this.asset || null,
      decimals: this.decimals,
    };
  }
}
