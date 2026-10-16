// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { beginToolCallReport } from './scheduleToolCallReport';

const { reportMarketTelemetry } = vi.hoisted(() => ({ reportMarketTelemetry: vi.fn() }));

vi.mock('@/server/services/marketTelemetry/reporter', () => ({ reportMarketTelemetry }));
vi.mock('@/server/utils/scheduleAfterResponse', () => ({
  after: (work: () => unknown) => void work(),
}));

const baseParams = {
  context: { serverDB: {} as never, telemetryEnabled: true, userId: 'user_1' },
  identifier: 'test-plugin',
  mcpType: 'http',
  requestPayload: { arg: 'value' },
  toolName: 'testTool',
};

const lastReport = () => reportMarketTelemetry.mock.calls.at(-1)![0].body as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  reportMarketTelemetry.mockResolvedValue({ attempts: 1, duplicate: false, status: 'delivered' });
});

describe('beginToolCallReport', () => {
  it('reports through the shared boundary, once, when the call completes', () => {
    const report = beginToolCallReport(baseParams);

    expect(reportMarketTelemetry).not.toHaveBeenCalled();
    report.complete({ result: { content: 'ok' }, success: true });
    report.complete({ success: false });

    expect(reportMarketTelemetry).toHaveBeenCalledTimes(1);
    expect(lastReport()).toMatchObject({
      identifier: 'test-plugin',
      methodName: 'testTool',
      success: true,
    });
  });

  // The client keeps one id for an invocation, whatever the transport does.
  it('names the event after the id the client gave the invocation', () => {
    beginToolCallReport({
      ...baseParams,
      meta: { executionId: 'inv-7' },
    }).complete({ success: true });
    beginToolCallReport({
      ...baseParams,
      meta: { executionId: 'inv-7' },
    }).complete({ success: true });

    const ids = reportMarketTelemetry.mock.calls.map(([report]) => report.eventId);
    expect(ids).toEqual(['v1:call:inv-7:1', 'v1:call:inv-7:1']);
  });

  it('treats a client that gave no id as an independent execution each time', () => {
    beginToolCallReport(baseParams).complete({ success: true });
    beginToolCallReport(baseParams).complete({ success: true });

    const ids = reportMarketTelemetry.mock.calls.map(([report]) => report.eventId);
    expect(new Set(ids).size).toBe(2);
  });

  it('lets the reporter decide, with what the request knows about the user', () => {
    beginToolCallReport({
      ...baseParams,
      context: { ...baseParams.context, marketAccessToken: 'm2m', telemetryEnabled: false },
    }).complete({ success: true });

    expect(reportMarketTelemetry.mock.calls[0][1]).toMatchObject({
      marketAccessToken: 'm2m',
      telemetryEnabled: false,
      userId: 'user_1',
    });
  });

  it('keeps the arguments and the result out of the report and sends their sizes', () => {
    const report = beginToolCallReport({ ...baseParams, requestPayload: { q: 'private words' } });

    report.complete({ result: { content: 'private answer' }, success: true });

    expect(JSON.stringify(lastReport())).not.toContain('private');
    expect(lastReport()).toMatchObject({
      requestSizeBytes: expect.any(Number),
      responseSizeBytes: expect.any(Number),
    });
  });

  it('carries what the client knows about a custom plugin', () => {
    beginToolCallReport({
      ...baseParams,
      meta: {
        customPluginInfo: { name: 'Mine' },
        isCustomPlugin: true,
        sessionId: 'topic-1',
        version: '0.1.0',
      },
    }).complete({ success: true });

    expect(lastReport()).toMatchObject({
      customPluginInfo: { name: 'Mine' },
      isCustomPlugin: true,
      sessionId: 'topic-1',
      version: '0.1.0',
    });
  });

  it.each([
    ['a thrown error', { thrown: new Error('boom') }],
    ['an error result', { result: { state: { isError: true } } }],
  ])('reports %s as a failure', (_label, completion) => {
    beginToolCallReport(baseParams).complete(completion);

    expect(lastReport()).toMatchObject({ success: false });
  });
});
