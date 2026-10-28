import { describe, expect, it } from 'vitest';

import {
  buildTelemetryEventId,
  composeExecutionId,
  inspectToolResultOutcome,
  newClientExecutionId,
  startTelemetryExecution,
  TelemetryEventIdError,
} from './index';

const fakeClock = (...readings: number[]) => {
  let index = 0;
  return { now: () => readings[Math.min(index++, readings.length - 1)] };
};

describe('buildTelemetryEventId', () => {
  it('follows v1:<eventType>:<executionId>:<attempt>', () => {
    expect(buildTelemetryEventId({ attempt: 2, eventType: 'call', executionId: 'op1:tc1' })).toBe(
      'v1:call:op1:tc1:2',
    );
  });

  it('gives independent executions and different attempts different ids', () => {
    const ids = [
      buildTelemetryEventId({ attempt: 1, eventType: 'call', executionId: 'a' }),
      buildTelemetryEventId({ attempt: 2, eventType: 'call', executionId: 'a' }),
      buildTelemetryEventId({ attempt: 1, eventType: 'call', executionId: 'b' }),
      buildTelemetryEventId({ attempt: 1, eventType: 'install', executionId: 'a' }),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses an id the wire contract cannot carry', () => {
    expect(() =>
      buildTelemetryEventId({ attempt: 1, eventType: 'call', executionId: 'x'.repeat(300) }),
    ).toThrow(TelemetryEventIdError);
    expect(() =>
      buildTelemetryEventId({ attempt: 0, eventType: 'call', executionId: 'a' }),
    ).toThrow(TelemetryEventIdError);
    expect(() =>
      buildTelemetryEventId({ attempt: 1.5, eventType: 'call', executionId: 'a' }),
    ).toThrow(TelemetryEventIdError);
    expect(() => buildTelemetryEventId({ attempt: 1, eventType: 'call', executionId: '' })).toThrow(
      TelemetryEventIdError,
    );
  });
});

describe('composeExecutionId', () => {
  // `a:b` + `c` and `a` + `b:c` must not name the same execution.
  it('keeps the parts apart whatever characters they carry', () => {
    expect(composeExecutionId('a:b', 'c')).not.toBe(composeExecutionId('a', 'b:c'));
    expect(composeExecutionId('op', 'call_1')).toBe('op:call_1');
  });
});

describe('startTelemetryExecution', () => {
  const identity = { attempt: 1, eventType: 'call' as const, executionId: 'op:tc' };

  it('fixes the duration with the monotonic clock at completion', () => {
    const execution = startTelemetryExecution(identity, { clock: fakeClock(100, 350.4) });

    const completed = execution.complete({ success: true });

    expect(completed.durationMs).toBe(250);
    expect(completed.eventId).toBe('v1:call:op:tc:1');
  });

  it('never reports a negative duration', () => {
    const execution = startTelemetryExecution(identity, { clock: fakeClock(500, 100) });

    expect(execution.complete({ success: true }).durationMs).toBe(0);
  });

  it('takes the first completion and ignores later ones', () => {
    const execution = startTelemetryExecution(identity, { clock: fakeClock(0, 10, 9999) });

    const first = execution.complete({ success: true });
    const second = execution.complete({ thrown: new Error('late') });

    expect(second).toBe(first);
    expect(second.success).toBe(true);
    expect(second.durationMs).toBe(10);
  });

  it('stamps occurredAt at completion as ISO 8601 with a timezone', () => {
    const execution = startTelemetryExecution(identity, {
      clock: fakeClock(0, 1),
      now: () => new Date('2026-10-16T08:00:00.000Z'),
    });

    expect(execution.complete({ success: true }).occurredAt).toBe('2026-10-16T08:00:00.000Z');
  });

  it('returns a snapshot nothing can change afterwards', () => {
    const completed = startTelemetryExecution(identity).complete({ success: true });

    expect(Object.isFrozen(completed)).toBe(true);
  });

  describe('success', () => {
    const run = (outcome: Parameters<ReturnType<typeof startTelemetryExecution>['complete']>[0]) =>
      startTelemetryExecution(identity).complete(outcome);

    it.each([
      ['success: false', { success: false }],
      ['isError', { isError: true }],
      ['a thrown error', { thrown: new Error('boom') }],
      ['isError beside success: true', { isError: true, success: true }],
      ['a thrown non-error', { thrown: 'string' }],
    ])('is false for %s', (_label, outcome) => {
      expect(run(outcome).success).toBe(false);
    });

    it('is true for a normal result', () => {
      expect(run({ success: true }).success).toBe(true);
      expect(run({}).success).toBe(true);
    });

    it('carries a safe error code and a bounded, redacted message', () => {
      const completed = run({
        errorCode: 'MCP_EXECUTION_ERROR',
        errorMessage: `failed with Bearer abc.def.ghi and password=hunter2 ${'x'.repeat(2000)}`,
        success: false,
      });

      expect(completed.errorCode).toBe('MCP_EXECUTION_ERROR');
      expect(completed.errorMessage).not.toContain('abc.def.ghi');
      expect(completed.errorMessage).not.toContain('hunter2');
      expect(completed.errorMessage!.length).toBeLessThanOrEqual(500);
    });

    it('names a thrown failure when the caller gave no code', () => {
      const completed = run({ thrown: Object.assign(new Error('x'), { code: 'ECONNRESET' }) });

      expect(completed.errorCode).toBe('ECONNRESET');
      expect(run({ thrown: new Error('x') }).errorCode).toBe('CALL_FAILED');
    });

    it('does not invent an error code for a success', () => {
      expect(run({ success: true }).errorCode).toBeUndefined();
    });
  });
});

describe('inspectToolResultOutcome', () => {
  it('reads the flat shapes', () => {
    expect(inspectToolResultOutcome({ content: 'x', success: true })).toEqual({});
    expect(inspectToolResultOutcome({ success: false })).toEqual({ success: false });
    expect(inspectToolResultOutcome({ isError: true })).toEqual({ isError: true });
  });

  // `mcpService.callTool` returns `{ content, state: { isError }, success }` and
  // the executor wraps it once more as `state`.
  it('finds a failure the result envelope nests', () => {
    expect(inspectToolResultOutcome({ state: { isError: true } })).toEqual({ isError: true });
    expect(
      inspectToolResultOutcome({ state: { state: { isError: true }, success: false } }),
    ).toEqual({ isError: true, success: false });
  });

  it('does not take anything else for a failure', () => {
    expect(inspectToolResultOutcome(undefined)).toEqual({});
    expect(inspectToolResultOutcome('text')).toEqual({});
    expect(inspectToolResultOutcome({ state: { isError: 'yes', success: 'no' } })).toEqual({});
  });
});

describe('newClientExecutionId', () => {
  it('is a different id for every execution', () => {
    const ids = Array.from({ length: 50 }, () => newClientExecutionId());

    expect(new Set(ids).size).toBe(50);
  });

  it('fits an event id with room to spare', () => {
    expect(
      buildTelemetryEventId({
        attempt: 1,
        eventType: 'uninstall',
        executionId: newClientExecutionId(),
      }).length,
    ).toBeLessThan(80);
  });
});
