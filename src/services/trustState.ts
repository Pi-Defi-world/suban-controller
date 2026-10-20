/**
 * Explicit oracle trust state machine.
 *
 * States:
 *   HEALTHY  - enough fresh sources and confidence is acceptable
 *   DEGRADED - sources/confidence below the configured bar
 *   BREAKER  - circuit breaker is active
 *   RECOVERY - breaker cleared; waiting for a healthy streak before HEALTHY
 *
 * The machine is deliberately pure: callers pass the inputs and a clock, which
 * makes transitions deterministic and easy to test.
 */

export type TrustState = 'HEALTHY' | 'DEGRADED' | 'BREAKER' | 'RECOVERY';

export interface TrustInput {
  sourcesUsed: number;
  totalSources: number;
  confidence: number;
  minSourcesMet: boolean;
  circuitBreakerActive: boolean;
}

export interface TrustSnapshot {
  state: TrustState;
  /** ISO timestamp of when the current state was entered. */
  since: string;
  /** Human-readable explanation of the current state. */
  reason: string;
  /** Consecutive healthy evaluations (used by RECOVERY). */
  healthy_streak: number;
}

export interface TrustTransition {
  from: TrustState;
  to: TrustState;
  at: string;
  reason: string;
}

export interface TrustStateOptions {
  /** Minimum confidence required for HEALTHY. */
  degradedConfidence?: number;
  /** Minimum fraction of sources that must be usable. */
  minSourceRatio?: number;
  /** Consecutive healthy evaluations required to leave RECOVERY. */
  recoveryStreak?: number;
  /** Injectable clock, in epoch milliseconds. */
  now?: () => number;
}

const MAX_TRANSITIONS = 100;

export class TrustStateMachine {
  private readonly degradedConfidence: number;
  private readonly minSourceRatio: number;
  private readonly recoveryStreak: number;
  private readonly now: () => number;

  private state: TrustState = 'DEGRADED';
  private since: number;
  private reason = 'awaiting first observation';
  private healthyStreak = 0;
  private transitions: TrustTransition[] = [];

  constructor(options: TrustStateOptions = {}) {
    this.degradedConfidence = options.degradedConfidence ?? 0.5;
    this.minSourceRatio = options.minSourceRatio ?? 0.5;
    this.recoveryStreak = Math.max(1, options.recoveryStreak ?? 3);
    this.now = options.now ?? Date.now;
    this.since = this.now();
  }

  evaluate(input: TrustInput): TrustSnapshot {
    const now = this.now();
    const sourceRatio = input.totalSources > 0 ? input.sourcesUsed / input.totalSources : 0;
    const healthy =
      input.minSourcesMet &&
      input.sourcesUsed > 0 &&
      sourceRatio >= this.minSourceRatio &&
      input.confidence >= this.degradedConfidence;

    if (input.circuitBreakerActive) {
      this.healthyStreak = 0;
      this.moveTo('BREAKER', now, 'circuit breaker active');
      return this.snapshot();
    }

    if (this.state === 'BREAKER') {
      this.healthyStreak = healthy ? 1 : 0;
      this.moveTo(
        healthy ? 'RECOVERY' : 'DEGRADED',
        now,
        healthy
          ? 'breaker cleared; waiting for a healthy streak'
          : 'breaker cleared but sources are below the health bar'
      );
      return this.snapshot();
    }

    if (this.state === 'RECOVERY') {
      if (!healthy) {
        this.healthyStreak = 0;
        this.moveTo('DEGRADED', now, this.degradedReason(input, sourceRatio));
        return this.snapshot();
      }

      this.healthyStreak += 1;
      if (this.healthyStreak >= this.recoveryStreak) {
        this.moveTo('HEALTHY', now, `recovered after ${this.healthyStreak} healthy evaluations`);
      } else {
        this.reason = `recovering (${this.healthyStreak}/${this.recoveryStreak} healthy evaluations)`;
      }
      return this.snapshot();
    }

    if (healthy) {
      this.healthyStreak += 1;
      this.moveTo('HEALTHY', now, 'sources and confidence within bounds');
    } else {
      this.healthyStreak = 0;
      this.moveTo('DEGRADED', now, this.degradedReason(input, sourceRatio));
    }

    return this.snapshot();
  }

  snapshot(): TrustSnapshot {
    return {
      state: this.state,
      since: new Date(this.since).toISOString(),
      reason: this.reason,
      healthy_streak: this.healthyStreak,
    };
  }

  /** Newest transition first. */
  getHistory(limit: number = 50): TrustTransition[] {
    const bounded = Math.max(0, Math.min(limit, MAX_TRANSITIONS));
    return this.transitions.slice(-bounded).reverse();
  }

  private degradedReason(input: TrustInput, sourceRatio: number): string {
    if (!input.minSourcesMet) {
      return `minimum sources not met (${input.sourcesUsed}/${input.totalSources})`;
    }
    if (input.sourcesUsed === 0) {
      return 'no usable sources';
    }
    if (sourceRatio < this.minSourceRatio) {
      return `too few usable sources (${input.sourcesUsed}/${input.totalSources})`;
    }
    return `confidence ${input.confidence.toFixed(3)} below ${this.degradedConfidence}`;
  }

  private moveTo(next: TrustState, now: number, reason: string): void {
    if (next === this.state) {
      this.reason = reason;
      return;
    }

    this.transitions.push({
      from: this.state,
      to: next,
      at: new Date(now).toISOString(),
      reason,
    });
    if (this.transitions.length > MAX_TRANSITIONS) {
      this.transitions = this.transitions.slice(-MAX_TRANSITIONS);
    }

    this.state = next;
    this.since = now;
    this.reason = reason;
  }
}
