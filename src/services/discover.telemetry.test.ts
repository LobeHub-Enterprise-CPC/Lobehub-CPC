import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lambdaClient, telemetryAllowed } = vi.hoisted(() => {
  const mutation = () => ({ mutate: vi.fn().mockResolvedValue({ success: true }) });
  return {
    lambdaClient: {
      market: {
        reportAgentEvent: mutation(),
        reportAgentInstall: mutation(),
        reportCall: mutation(),
        reportGroupAgentEvent: mutation(),
        reportGroupAgentInstall: mutation(),
        reportMcpEvent: mutation(),
        reportMcpInstallResult: mutation(),
      },
    },
    telemetryAllowed: { current: true },
  };
});

vi.mock('@/libs/trpc/client', () => ({ lambdaClient }));
vi.mock('@/store/user', () => ({ useUserStore: { getState: () => ({}) } }));
vi.mock('@/store/user/selectors', () => ({
  userGeneralSettingsSelectors: { telemetry: () => telemetryAllowed.current },
}));
vi.mock('@/store/global/helpers', () => ({ globalHelpers: { getCurrentLanguage: () => 'en-US' } }));

const { discoverService } = await import('./discover');

const completed = {
  attempt: 1,
  durationMs: 1500,
  errorCode: undefined,
  eventId: 'v1:install:inv-1:1',
  eventType: 'install' as const,
  occurredAt: '2026-10-16T08:00:00.000Z',
  success: true,
};

const sentTo = (name: keyof typeof lambdaClient.market) =>
  lambdaClient.market[name].mutate.mock.calls.map(([input]) => input as Record<string, any>);

beforeEach(() => {
  vi.clearAllMocks();
  telemetryAllowed.current = true;
  // @ts-expect-error trusted client on: authentication is the server's job
  globalThis.window = {
    global_serverConfigStore: {
      getState: () => ({ serverConfig: { enableMarketTrustedClient: true } }),
    },
  };
});

describe('interaction reports', () => {
  it('gives every interaction an identity of its own, fixed here', async () => {
    await discoverService.reportMcpEvent({ event: 'click', identifier: 'github' });
    await discoverService.reportMcpEvent({ event: 'click', identifier: 'github' });

    const [first, second] = sentTo('reportMcpEvent');
    expect(first.eventId).toMatch(/^v1:click:.+:1$/);
    expect(first.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(first.eventId).not.toBe(second.eventId);
  });

  it.each([
    ['reportAgentEvent', 'reportAgentEvent'],
    ['reportGroupAgentEvent', 'reportGroupAgentEvent'],
  ] as const)('%s carries event identity', async (method, procedure) => {
    await discoverService[method]({ event: 'add', identifier: 'x' });

    expect(sentTo(procedure)[0]).toMatchObject({
      event: 'add',
      eventId: expect.stringMatching(/^v1:add:/),
      identifier: 'x',
      occurredAt: expect.any(String),
    });
  });

  it.each([
    ['reportAgentInstall', 'reportAgentInstall'],
    ['reportGroupAgentInstall', 'reportGroupAgentInstall'],
  ] as const)('%s is an install event', async (method, procedure) => {
    await discoverService[method]('x');

    expect(sentTo(procedure)[0]).toMatchObject({
      eventId: expect.stringMatching(/^v1:install:/),
      identifier: 'x',
    });
  });

  it('reports nothing once the user opted out', async () => {
    telemetryAllowed.current = false;

    await discoverService.reportMcpEvent({ event: 'click', identifier: 'github' });
    await discoverService.reportAgentEvent({ event: 'chat', identifier: 'a' });
    await discoverService.reportAgentInstall('a');
    await discoverService.reportGroupAgentEvent({ event: 'add', identifier: 'g' });
    await discoverService.reportGroupAgentInstall('g');

    for (const name of Object.keys(lambdaClient.market) as Array<
      keyof typeof lambdaClient.market
    >) {
      expect(lambdaClient.market[name].mutate).not.toHaveBeenCalled();
    }
  });
});

describe('reportMcpInstallResult', () => {
  it('sends the facts the installer fixed, not ones recomputed here', async () => {
    await discoverService.reportMcpInstallResult({
      execution: completed,
      identifier: 'github',
      manifest: { tools: [] } as never,
      platform: 'darwin',
      version: '1.0.0',
    });

    expect(sentTo('reportMcpInstallResult')[0]).toMatchObject({
      eventId: 'v1:install:inv-1:1',
      identifier: 'github',
      installDurationMs: 1500,
      occurredAt: '2026-10-16T08:00:00.000Z',
      success: true,
    });
  });

  it('reports a failure with its code and no manifest', async () => {
    await discoverService.reportMcpInstallResult({
      execution: {
        ...completed,
        errorCode: 'STDIO_ERROR',
        errorMessage: 'no node',
        success: false,
      },
      identifier: 'github',
      manifest: { tools: [] } as never,
      version: '1.0.0',
    });

    expect(sentTo('reportMcpInstallResult')[0]).toMatchObject({
      errorCode: 'STDIO_ERROR',
      errorMessage: 'no node',
      success: false,
    });
    expect(sentTo('reportMcpInstallResult')[0]).not.toHaveProperty('manifest');
  });

  it('never sends the connection parameters the plugin was installed with', async () => {
    await discoverService.reportMcpInstallResult({
      execution: completed,
      identifier: 'github',
      installParams: { env: { TOKEN: 'secret-value' } },
      version: '1.0.0',
    } as never);

    expect(JSON.stringify(sentTo('reportMcpInstallResult')[0])).not.toContain('secret-value');
  });
});

describe('reportPluginCall', () => {
  it('sends the call with the facts its execution fixed', async () => {
    await discoverService.reportPluginCall({
      execution: { ...completed, durationMs: 77, eventId: 'v1:call:inv-2:1', eventType: 'call' },
      identifier: 'github',
      methodName: 'search',
      methodType: 'tool',
      version: '1.0.0',
    });

    expect(sentTo('reportCall')[0]).toMatchObject({
      callDurationMs: 77,
      eventId: 'v1:call:inv-2:1',
      identifier: 'github',
      success: true,
    });
  });
});
