// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { type TelemetryReport } from '@/libs/market-telemetry';

import { beginToolCallTelemetry, compactExecutionId } from './toolCall';

const setup = (input: Partial<Parameters<typeof beginToolCallTelemetry>[0]> = {}) => {
  const reports: Array<{ context: unknown; report: TelemetryReport }> = [];
  const readings = [1000, 1250];
  const telemetry = beginToolCallTelemetry(
    {
      context: { serverDB: {} as never, userId: 'u1' },
      executionId: 'op1:call_1',
      identifier: 'github',
      mcpType: 'cloud',
      methodName: 'search',
      requestPayload: { q: 'secret question' },
      ...input,
    },
    {
      clock: { now: () => readings.shift() ?? 9999 },
      now: () => new Date('2026-10-16T08:00:00.000Z'),
      report: async (report, context) => {
        reports.push({ context, report });
        return { attempts: 1, duplicate: false, status: 'delivered' };
      },
      schedule: (work) => void work(),
    },
  );
  return { reports, telemetry };
};

describe('beginToolCallTelemetry', () => {
  it('names the event after the execution and the scheduler attempt', () => {
    expect(setup({ attempt: 2 }).telemetry.eventId).toBe('v1:call:op1:call_1:2');
    expect(setup().telemetry.eventId).toBe('v1:call:op1:call_1:1');
  });

  it('makes two independent executions two different events', () => {
    const a = setup({ executionId: undefined }).telemetry.eventId;
    const b = setup({ executionId: undefined }).telemetry.eventId;

    expect(a).not.toBe(b);
  });

  it('reports once, with duration and time fixed when it completed', () => {
    const { reports, telemetry } = setup();

    telemetry.complete({ result: { content: 'x' }, success: true });
    telemetry.complete({ thrown: new Error('too late') });

    expect(reports).toHaveLength(1);
    expect(reports[0].report.body).toMatchObject({
      callDurationMs: 250,
      eventId: 'v1:call:op1:call_1:1',
      identifier: 'github',
      methodName: 'search',
      occurredAt: '2026-10-16T08:00:00.000Z',
      success: true,
    });
  });

  it('hands the reporter the context it needs to decide and authenticate', () => {
    const { reports, telemetry } = setup({
      context: {
        marketAccessToken: 'm2m',
        serverDB: {} as never,
        telemetryEnabled: true,
        userId: 'u1',
      },
    });

    telemetry.complete({ success: true });

    expect(reports[0].context).toMatchObject({
      marketAccessToken: 'm2m',
      telemetryEnabled: true,
      userId: 'u1',
    });
  });

  describe('success', () => {
    it.each([
      ['an explicit failure', { success: false }],
      ['an error result', { result: { state: { isError: true } } }],
      [
        'a failed result envelope',
        { result: { state: { state: { isError: true }, success: false } } },
      ],
      ['a thrown error', { thrown: new Error('boom') }],
    ])('is false for %s', (_label, completion) => {
      const { reports, telemetry } = setup();

      telemetry.complete(completion);

      expect(reports[0].report.body).toMatchObject({ success: false });
      expect(reports[0].report.body.errorCode).toEqual(expect.any(String));
    });

    it('is true for a result that says nothing against itself', () => {
      const { reports, telemetry } = setup();

      telemetry.complete({ result: { content: 'ok', state: { content: [] }, success: true } });

      expect(reports[0].report.body).toMatchObject({ success: true });
      expect(reports[0].report.body).not.toHaveProperty('errorCode');
    });

    it('carries the failure code the executor classified', () => {
      const { reports, telemetry } = setup();

      telemetry.complete({
        errorCode: 'MCP_DEVICE_EXECUTION_ERROR',
        errorMessage: 'device gone',
        success: false,
      });

      expect(reports[0].report.body).toMatchObject({
        errorCode: 'MCP_DEVICE_EXECUTION_ERROR',
        errorMessage: 'device gone',
        success: false,
      });
    });
  });

  it('sends sizes and never the arguments or the result', () => {
    const { reports, telemetry } = setup();

    telemetry.complete({ result: { content: 'private answer' }, success: true });

    const body = JSON.stringify(reports[0].report.body);
    expect(body).not.toContain('secret question');
    expect(body).not.toContain('private answer');
    expect(reports[0].report.body).toMatchObject({
      requestSizeBytes: expect.any(Number),
      responseSizeBytes: expect.any(Number),
    });
  });

  it('describes a tunnelled call as such', () => {
    const { reports, telemetry } = setup({ mcpType: 'stdio', viaDevice: true });

    telemetry.complete({ success: true });

    expect(reports[0].report.body.metadata).toMatchObject({ mcpType: 'stdio', viaDevice: true });
  });

  it('learns it was tunnelled only when the call completes', () => {
    const { reports, telemetry } = setup({ mcpType: 'stdio' });

    telemetry.complete({ success: true, viaDevice: true });

    expect(reports[0].report.body.metadata).toMatchObject({ viaDevice: true });
  });

  it('survives a reporter that throws', () => {
    const telemetry = beginToolCallTelemetry(
      {
        context: { userId: 'u1' },
        executionId: 'e',
        identifier: 'a',
        methodName: 'm',
      },
      {
        report: async () => {
          throw new Error('network');
        },
        schedule: (work) => void work(),
      },
    );

    expect(() => telemetry.complete({ success: true })).not.toThrow();
  });
});

describe('compactExecutionId', () => {
  it('leaves a normal id alone', () => {
    expect(compactExecutionId('op:call_1')).toBe('op:call_1');
  });

  it('keeps an oversized id inside the wire limit, deterministically and apart from others', () => {
    const long = 'x'.repeat(400);
    const other = `${'x'.repeat(399)}y`;

    expect(compactExecutionId(long).length).toBeLessThanOrEqual(150);
    expect(compactExecutionId(long)).toBe(compactExecutionId(long));
    expect(compactExecutionId(long)).not.toBe(compactExecutionId(other));
  });

  it('still produces an event id for an oversized execution', () => {
    const { telemetry } = setup({ executionId: 'z'.repeat(1000) });

    expect(telemetry.eventId.length).toBeLessThanOrEqual(255);
  });
});
