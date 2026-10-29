// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectorRouter } from './connector';

// Unlike connector.callTool.test.ts, the reporter here is the real one: only the
// network is replaced, so what is asserted is what would leave the server.
const { appEnv, callConnectorToolById } = vi.hoisted(() => ({
  appEnv: {
    MARKET_TRUSTED_CLIENT_ID: undefined as string | undefined,
    MARKET_TRUSTED_CLIENT_SECRET: undefined as string | undefined,
    TELEMETRY_DISABLED: false,
  },
  callConnectorToolById: vi.fn(),
}));

vi.mock('@/envs/app', () => ({ appEnv }));
vi.mock('@/database/models/user', () => ({
  UserModel: Object.assign(
    vi.fn(function () {
      return {};
    }),
    { findById: vi.fn(async () => ({ email: 'ada@example.com', fullName: 'Ada' })) },
  ),
}));
vi.mock('@lobehub/market-sdk', () => ({
  buildTrustedClientPayload: vi.fn((params) => ({ ...params, nonce: 'n', timestamp: 0 })),
  // Like the private SDK: the payload's clientId goes in front of the ciphertext as the kid.
  createTrustedClientToken: vi.fn(
    (payload: { clientId: string }) => `${payload.clientId}.signed-trust-token`,
  ),
}));
vi.mock('@/libs/trpc/lambda/middleware', () => ({
  serverDatabase: vi.fn(function (opts: any) {
    return opts.next({ ctx: opts.ctx });
  }),
  // What the real middleware hands on once the user's own choice is known.
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
vi.mock('@/server/utils/scheduleAfterResponse', () => ({
  after: (work: () => unknown) => void work(),
}));

const inTenant = <T>(fn: () => T) =>
  runWithTenantScope(
    {
      session: {},
      slug: 'a',
      tenantId: '00000000-0000-4000-8000-000000000001',
    } as unknown as TenantScope,
    fn,
  );

const call = () =>
  connectorRouter
    .createCaller({ marketAccessToken: 'mp-user-token', serverDB: {}, userId: 'user_1' } as any)
    .callTool({ executionId: 'inv-1', identifier: 'my-conn', toolName: 'do_thing' });

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  appEnv.MARKET_TRUSTED_CLIENT_ID = undefined;
  appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;
  callConnectorToolById.mockResolvedValue({ content: 'ok', success: true });
  fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(JSON.stringify({ duplicate: false, success: true })));
});

afterEach(() => {
  fetchSpy.mockRestore();
});

const sent = () =>
  fetchSpy.mock.calls.map(([url, init]) => ({
    body: JSON.parse((init as RequestInit).body as string),
    headers: (init as RequestInit).headers as Record<string, string>,
    url: String(url),
  }));

describe('connector.callTool telemetry delivery', () => {
  it('without tenants: sends the report with the user Market token as Bearer', async () => {
    await call();
    await settle();

    expect(sent()).toHaveLength(1);
    expect(sent()[0].url).toContain('/api/v1/plugins/report/call');
    expect(sent()[0].headers.Authorization).toBe('Bearer mp-user-token');
    expect(sent()[0].headers).not.toHaveProperty('x-lobe-trust-token');
    expect(sent()[0].body).toMatchObject({ eventId: 'v1:call:inv-1:1', success: true });
  });

  it('in a tenant: sends only the trust token, never the Bearer', async () => {
    appEnv.MARKET_TRUSTED_CLIENT_ID = 'client-id';
    appEnv.MARKET_TRUSTED_CLIENT_SECRET = 'client-secret';

    await inTenant(() => call());
    await settle();

    expect(sent()).toHaveLength(1);
    expect(sent()[0].headers['x-lobe-trust-token']).toBe('client-id.signed-trust-token');
    expect(sent()[0].headers).not.toHaveProperty('Authorization');
  });
});
