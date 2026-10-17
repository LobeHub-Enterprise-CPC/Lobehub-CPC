// @vitest-environment node
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { router } from '@/libs/trpc/lambda';

import { telemetryProcedures } from './telemetry';

const { reportMarketTelemetry } = vi.hoisted(() => ({ reportMarketTelemetry: vi.fn() }));

vi.mock('@/libs/trpc/lambda/middleware', () => ({
  marketUserInfo: vi.fn(function (opts: any) {
    return opts.next({ ctx: { ...opts.ctx, marketAccessToken: 'm2m-token' } });
  }),
  serverDatabase: vi.fn(function (opts: any) {
    return opts.next({ ctx: { ...opts.ctx, serverDB: { db: true } } });
  }),
}));
vi.mock('@/server/services/marketTelemetry/reporter', () => ({ reportMarketTelemetry }));
vi.mock('@/server/utils/scheduleAfterResponse', () => ({
  after: (work: () => unknown) => void work(),
}));

const caller = router(telemetryProcedures).createCaller({
  userAgent: 'test-agent',
  userId: 'user_1',
} as never);

const identity = { eventId: 'v1:call:inv-1:1', occurredAt: '2026-10-16T08:00:00.000Z' };

const sent = () =>
  reportMarketTelemetry.mock.calls.map(([report, context]) => ({
    context,
    path: report.path as string,
    ...(report.body as Record<string, any>),
  }));

beforeEach(() => {
  vi.clearAllMocks();
  reportMarketTelemetry.mockResolvedValue({ attempts: 1, duplicate: false, status: 'delivered' });
});

describe('reportCall', () => {
  const input = {
    ...identity,
    callDurationMs: 321,
    identifier: 'github',
    methodName: 'search',
    methodType: 'tool' as const,
    success: true,
    version: '1.0.0',
  };

  it('forwards the client-fixed facts untouched, to the call endpoint', async () => {
    const result = await caller.reportCall({ ...input, requestSizeBytes: 12 });

    expect(result).toEqual({ success: true });
    expect(sent()[0]).toMatchObject({
      callDurationMs: 321,
      eventId: 'v1:call:inv-1:1',
      identifier: 'github',
      occurredAt: '2026-10-16T08:00:00.000Z',
      path: '/api/v1/plugins/report/call',
      requestSizeBytes: 12,
      success: true,
    });
  });

  it('is the same event when the client retries the same call', async () => {
    await caller.reportCall(input);
    await caller.reportCall(input);

    expect(sent()[0].eventId).toBe(sent()[1].eventId);
  });

  it('reports a failure with its code', async () => {
    await caller.reportCall({
      ...input,
      errorCode: 'CALL_FAILED',
      errorMessage: 'boom with Bearer abc.def',
      success: false,
    });

    expect(sent()[0]).toMatchObject({ errorCode: 'CALL_FAILED', success: false });
    expect(JSON.stringify(sent()[0])).not.toContain('abc.def');
  });

  it('refuses a call without an event identity', async () => {
    const { eventId: _eventId, ...withoutId } = input as Record<string, unknown>;

    await expect(
      (caller.reportCall as any)({ ...withoutId, occurredAt: identity.occurredAt }),
    ).rejects.toThrow();
    expect(reportMarketTelemetry).not.toHaveBeenCalled();
  });

  it('refuses a time that is not an instant', async () => {
    await expect(caller.reportCall({ ...input, occurredAt: 'yesterday' })).rejects.toBeInstanceOf(
      TRPCError,
    );
    expect(reportMarketTelemetry).not.toHaveBeenCalled();
  });

  // The authenticated identity decides who the call belongs to.
  it('does not carry a client id the request names', async () => {
    await (caller.reportCall as any)({ ...input, clientId: 'someone-elses-client' });

    expect(JSON.stringify(sent()[0])).not.toContain('someone-elses-client');
  });

  it('reports for the user and database of the request', async () => {
    await caller.reportCall(input);

    expect(sent()[0].context).toMatchObject({
      marketAccessToken: 'm2m-token',
      serverDB: { db: true },
      userId: 'user_1',
    });
  });

  it('does not wait for, or fail with, the delivery', async () => {
    reportMarketTelemetry.mockRejectedValue(new Error('market down'));

    await expect(caller.reportCall(input)).resolves.toEqual({ success: true });
  });
});

describe('reportMcpInstallResult', () => {
  it('forwards the install facts and leaves the connection parameters out', async () => {
    await caller.reportMcpInstallResult({
      eventId: 'v1:install:inv-2:1',
      identifier: 'github',
      installDurationMs: 1500,
      installParams: { env: { TOKEN: 'secret-value' }, headers: { Authorization: 'Bearer x' } },
      manifest: { tools: [] },
      occurredAt: identity.occurredAt,
      success: true,
      version: '1.0.0',
    });

    expect(sent()[0]).toMatchObject({
      eventId: 'v1:install:inv-2:1',
      installDurationMs: 1500,
      path: '/api/v1/plugins/report/installation',
      success: true,
    });
    expect(JSON.stringify(sent()[0])).not.toContain('secret-value');
  });
});

describe('interaction events', () => {
  it('reportMcpEvent: a plugin event on the unified endpoint', async () => {
    await caller.reportMcpEvent({
      ...identity,
      event: 'install',
      eventId: 'v1:install:inv-3:1',
      identifier: 'github',
      source: 'community/mcp',
    });

    expect(sent()[0]).toMatchObject({
      eventId: 'v1:install:inv-3:1',
      eventType: 'install',
      path: '/api/v1/telemetry/events',
      resourceType: 'plugin',
      success: true,
    });
  });

  it('reportAgentEvent: an agent event', async () => {
    await caller.reportAgentEvent({
      ...identity,
      event: 'chat',
      eventId: 'v1:chat:a:1',
      identifier: 'a1',
    });

    expect(sent()[0]).toMatchObject({ eventType: 'chat', resourceType: 'agent' });
  });

  it('reportGroupAgentEvent: a group event', async () => {
    await caller.reportGroupAgentEvent({
      ...identity,
      event: 'add',
      eventId: 'v1:add:g:1',
      identifier: 'g1',
    });

    expect(sent()[0]).toMatchObject({ eventType: 'add', resourceType: 'agentGroup' });
  });

  it('reportAgentInstall / reportGroupAgentInstall: an install event, not a bare counter', async () => {
    await caller.reportAgentInstall({ ...identity, eventId: 'v1:install:a:1', identifier: 'a1' });
    await caller.reportGroupAgentInstall({
      ...identity,
      eventId: 'v1:install:g:1',
      identifier: 'g1',
    });

    expect(sent().map(({ eventType, resourceType }) => [eventType, resourceType])).toEqual([
      ['install', 'agent'],
      ['install', 'agentGroup'],
    ]);
  });
});
