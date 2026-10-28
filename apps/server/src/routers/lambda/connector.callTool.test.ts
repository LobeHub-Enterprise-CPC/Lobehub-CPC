// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectorToolCallError } from '@/server/services/connector/exec';

import { connectorRouter } from './connector';

const { callConnectorToolById, reportMarketTelemetry } = vi.hoisted(() => ({
  callConnectorToolById: vi.fn(),
  reportMarketTelemetry: vi.fn(),
}));

vi.mock('@/libs/trpc/lambda/middleware', () => ({
  serverDatabase: vi.fn(function (opts: any) {
    return opts.next({ ctx: opts.ctx });
  }),
  telemetry: vi.fn(function (opts: any) {
    return opts.next({ ctx: { ...opts.ctx, telemetryEnabled: true } });
  }),
}));
vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { initWithEnvKey: vi.fn().mockResolvedValue({}) },
}));
vi.mock('@/database/models/connector', () => ({
  ConnectorModel: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@/database/models/connectorTool', () => ({
  ConnectorToolModel: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@/database/models/plugin', () => ({
  PluginModel: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@/server/services/connector/exec', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callConnectorToolById,
}));
vi.mock('@/server/services/marketTelemetry/reporter', () => ({ reportMarketTelemetry }));
vi.mock('@/server/utils/scheduleAfterResponse', () => ({
  after: (work: () => unknown) => void work(),
}));

const call = (executionId?: string) =>
  connectorRouter
    .createCaller({ serverDB: {}, userId: 'user_1' } as any)
    .callTool({ args: '{"q":"secret"}', executionId, identifier: 'my-conn', toolName: 'do_thing' });

const reports = () =>
  reportMarketTelemetry.mock.calls.map(([report]) => report.body as Record<string, any>);

beforeEach(() => {
  vi.clearAllMocks();
  reportMarketTelemetry.mockResolvedValue({ attempts: 1, duplicate: false, status: 'delivered' });
});

// The classic chat reaches a connected MCP only through this procedure, so it
// is the execution-completion boundary for that path.
describe('connector.callTool telemetry', () => {
  it('reports a call that succeeded, once, under the client invocation id', async () => {
    callConnectorToolById.mockResolvedValue({ content: 'ok', success: true });

    await call('inv-9');

    expect(reports()).toHaveLength(1);
    expect(reports()[0]).toMatchObject({
      eventId: 'v1:call:inv-9:1',
      identifier: 'my-conn',
      methodName: 'do_thing',
      success: true,
    });
    expect(JSON.stringify(reports()[0])).not.toContain('secret');
  });

  it('reports a result that says it is an error as a failure', async () => {
    callConnectorToolById.mockResolvedValue({ content: 'bad', state: { isError: true } });

    await call('inv-9');

    expect(reports()[0]).toMatchObject({ success: false });
  });

  it('reports a call that threw as a failure, and still throws', async () => {
    callConnectorToolById.mockRejectedValue(new Error('upstream down'));

    await expect(call('inv-9')).rejects.toThrow('upstream down');

    expect(reports()).toHaveLength(1);
    expect(reports()[0]).toMatchObject({ eventId: 'v1:call:inv-9:1', success: false });
  });

  it('reports a call the connector refused (disabled tool) as a failed execution', async () => {
    callConnectorToolById.mockRejectedValue(
      new ConnectorToolCallError('FORBIDDEN', "Tool 'do_thing' is disabled for this connector"),
    );

    await expect(call('inv-9')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(reports()[0]).toMatchObject({ errorCode: 'FORBIDDEN', success: false });
  });

  it('treats a request without an invocation id as an independent execution', async () => {
    callConnectorToolById.mockResolvedValue({ content: 'ok' });

    await call();
    await call();

    const ids = reports().map((body) => body.eventId);
    expect(new Set(ids).size).toBe(2);
  });
});
