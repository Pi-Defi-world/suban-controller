import { TrustInput, TrustStateMachine } from './trustState';

function healthyInput(overrides: Partial<TrustInput> = {}): TrustInput {
  return {
    sourcesUsed: 4,
    totalSources: 4,
    confidence: 0.9,
    minSourcesMet: true,
    circuitBreakerActive: false,
    ...overrides,
  };
}

describe('TrustStateMachine', () => {
  let now: number;
  let machine: TrustStateMachine;

  beforeEach(() => {
    now = 1_700_000_000_000;
    machine = new TrustStateMachine({
      now: () => now,
      degradedConfidence: 0.5,
      minSourceRatio: 0.5,
      recoveryStreak: 3,
    });
  });

  it('starts degraded until the first observation', () => {
    expect(machine.snapshot()).toMatchObject({
      state: 'DEGRADED',
      reason: 'awaiting first observation',
    });
  });

  it('becomes healthy when enough fresh sources agree', () => {
    const snapshot = machine.evaluate(healthyInput());

    expect(snapshot.state).toBe('HEALTHY');
    expect(snapshot.healthy_streak).toBe(1);
    expect(machine.getHistory(10)).toHaveLength(1);
    expect(machine.getHistory(10)[0]).toMatchObject({
      from: 'DEGRADED',
      to: 'HEALTHY',
    });
  });

  it('degrades when confidence or source coverage falls', () => {
    machine.evaluate(healthyInput());

    const lowConfidence = machine.evaluate(healthyInput({ confidence: 0.2 }));
    expect(lowConfidence.state).toBe('DEGRADED');
    expect(lowConfidence.reason).toContain('confidence');

    machine.evaluate(healthyInput());
    const fewSources = machine.evaluate(
      healthyInput({ sourcesUsed: 1, totalSources: 4 })
    );
    expect(fewSources.state).toBe('DEGRADED');
    expect(fewSources.reason).toContain('too few usable sources');
  });

  it('requires a healthy streak after the breaker clears', () => {
    machine.evaluate(healthyInput());

    expect(
      machine.evaluate(healthyInput({ circuitBreakerActive: true })).state
    ).toBe('BREAKER');

    now += 60_000;
    const recovering = machine.evaluate(healthyInput());
    expect(recovering.state).toBe('RECOVERY');
    expect(recovering.healthy_streak).toBe(1);

    now += 1_000;
    const stillRecovering = machine.evaluate(healthyInput());
    expect(stillRecovering.state).toBe('RECOVERY');
    expect(stillRecovering.healthy_streak).toBe(2);

    now += 1_000;
    const recovered = machine.evaluate(healthyInput());
    expect(recovered.state).toBe('HEALTHY');
    expect(recovered.healthy_streak).toBe(3);
  });

  it('falls back to degraded if a source drops during recovery', () => {
    machine.evaluate(healthyInput({ circuitBreakerActive: true }));
    machine.evaluate(healthyInput());

    const degraded = machine.evaluate(
      healthyInput({ sourcesUsed: 1, totalSources: 4 })
    );

    expect(degraded.state).toBe('DEGRADED');
    expect(degraded.healthy_streak).toBe(0);
  });

  it('returns transitions newest first and caps stored history', () => {
    for (let i = 0; i < 200; i += 1) {
      machine.evaluate(healthyInput({ confidence: i % 2 === 0 ? 0.9 : 0.1 }));
    }

    const history = machine.getHistory(1_000);
    expect(history).toHaveLength(100);
    expect(new Date(history[0].at).getTime()).toBeGreaterThanOrEqual(
      new Date(history[1].at).getTime()
    );
  });
});
