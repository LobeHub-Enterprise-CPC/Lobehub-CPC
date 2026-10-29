// @vitest-environment node
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { createTrustedClientToken } from '@lobehub/market-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildInteractionReport, buildToolCallReport } from '@/libs/market-telemetry';

import { reportMarketTelemetry } from './reporter';

const { appEnv, userRow, userSettings } = vi.hoisted(() => ({
  appEnv: {
    MARKET_TRUSTED_CLIENT_ID: 'client-id' as string | undefined,
    MARKET_TRUSTED_CLIENT_SECRET: 'client-secret' as string | undefined,
    TELEMETRY_DISABLED: false,
  },
  userRow: { current: { email: 'ada@example.com', fullName: 'Ada' } as unknown },
  userSettings: { current: undefined as unknown, preference: undefined as unknown, throws: false },
}));

vi.mock('@/envs/app', () => ({ appEnv }));

vi.mock('@/database/models/user', () => ({
  UserModel: Object.assign(
    vi.fn(function () {
      return {
        getUserPreference: async () => {
          if (userSettings.throws) throw new Error('db down');
          return userSettings.preference;
        },
        getUserSettings: async () => {
          if (userSettings.throws) throw new Error('db down');
          return userSettings.current;
        },
      };
    }),
    { findById: vi.fn(async () => userRow.current) },
  ),
}));

let tokenCounter = 0;
vi.mock('@lobehub/market-sdk', () => ({
  buildTrustedClientPayload: vi.fn((params) => ({ ...params, nonce: 'n', timestamp: 0 })),
  // Like the private SDK: the payload's clientId goes in front of the ciphertext as the kid.
  createTrustedClientToken: vi.fn(
    (payload: { clientId: string }) => `${payload.clientId}.signed-token-${++tokenCounter}`,
  ),
}));

/** Market only accepts a canonical UUID as the signed tenant id. */
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const inTenant = <T>(tenantId: string, fn: () => T) =>
  runWithTenantScope({ session: {}, slug: tenantId, tenantId } as unknown as TenantScope, fn);

const serverDB = {} as never;

const completed = {
  attempt: 1,
  durationMs: 42,
  eventId: 'v1:call:op:tc:1',
  eventType: 'call' as const,
  occurredAt: '2026-10-16T08:00:00.000Z',
  success: true,
};

const report = buildToolCallReport(completed, {
  identifier: 'github',
  methodName: 'search',
  version: '1.0.0',
});

const response = (status: number, body: unknown = { duplicate: false, success: true }) =>
  new Response(JSON.stringify(body), { status });

const makeDeps = (...responses: Array<Response | Error>) => {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift() ?? response(201);
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    deps: {
      fetch: fetchMock as unknown as typeof fetch,
      retryDelaysMs: [0, 0],
      sleep: async () => {},
    },
    fetchMock,
  };
};

const sentHeaders = (fetchMock: ReturnType<typeof vi.fn>, index = 0) =>
  (fetchMock.mock.calls[index] as unknown as [string, RequestInit])[1].headers as Record<
    string,
    string
  >;
const sentBody = (fetchMock: ReturnType<typeof vi.fn>, index = 0) =>
  (fetchMock.mock.calls[index] as unknown as [string, RequestInit])[1].body as string;
const sentUrl = (fetchMock: ReturnType<typeof vi.fn>, index = 0) =>
  (fetchMock.mock.calls[index] as unknown as [string, RequestInit])[0];

beforeEach(() => {
  vi.clearAllMocks();
  tokenCounter = 0;
  appEnv.MARKET_TRUSTED_CLIENT_ID = 'client-id';
  appEnv.MARKET_TRUSTED_CLIENT_SECRET = 'client-secret';
  appEnv.TELEMETRY_DISABLED = false;
  userRow.current = { email: 'ada@example.com', fullName: 'Ada' };
  userSettings.current = undefined;
  userSettings.preference = undefined;
  userSettings.throws = false;
  process.env.MARKET_BASE_URL = 'https://market.test';
});

describe('reportMarketTelemetry: whether to report at all', () => {
  it('does not report when the environment disables telemetry, whatever the user chose', async () => {
    appEnv.TELEMETRY_DISABLED = true;
    const { deps, fetchMock } = makeDeps();

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB, telemetryEnabled: true, userId: 'u1' }, deps),
    );

    expect(result).toMatchObject({ reason: 'env-disabled', status: 'skipped' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not report when the user turned telemetry off', async () => {
    userSettings.current = { general: { telemetry: false } };
    const { deps, fetchMock } = makeDeps();

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB, userId: 'u1' }, deps),
    );

    expect(result).toMatchObject({ reason: 'user-disabled', status: 'skipped' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createTrustedClientToken).not.toHaveBeenCalled();
  });

  it('does not report when the caller already knows the user opted out', async () => {
    const { deps, fetchMock } = makeDeps();

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB, telemetryEnabled: false, userId: 'u1' }, deps),
    );

    expect(result).toMatchObject({ reason: 'user-disabled', status: 'skipped' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The check failing is not consent.
  it('does not report when the opt-out check itself fails', async () => {
    userSettings.throws = true;
    const { deps, fetchMock } = makeDeps();

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB, userId: 'u1' }, deps),
    );

    expect(result.status).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not report for nobody', async () => {
    const { deps, fetchMock } = makeDeps();

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB }, deps),
    );

    expect(result).toMatchObject({ reason: 'no-user', status: 'skipped' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('reportMarketTelemetry: in a tenant', () => {
  it('signs the tenant into a trust token and reports to the endpoint the report names', async () => {
    const { deps, fetchMock } = makeDeps(response(201));

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB, userId: 'u1' }, deps),
    );

    expect(result).toMatchObject({ duplicate: false, status: 'delivered' });
    expect(sentUrl(fetchMock)).toBe('https://market.test/api/v1/plugins/report/call');
    expect(sentHeaders(fetchMock)['x-lobe-trust-token']).toBe('client-id.signed-token-1');
    expect(sentHeaders(fetchMock)).not.toHaveProperty('Authorization');
    expect(JSON.parse(sentBody(fetchMock))).toEqual(report.body);
    expect(vi.mocked(createTrustedClientToken).mock.calls[0][0]).toMatchObject({
      email: 'ada@example.com',
      tenantId: TENANT_ID,
      userId: 'u1',
    });
  });

  it('uses the unified endpoint for interaction events', async () => {
    const { deps, fetchMock } = makeDeps();
    const event = buildInteractionReport(
      { ...completed, eventId: 'v1:add:x:1', eventType: 'add' },
      { identifier: 'agent', resourceType: 'agent' },
    );

    await inTenant(TENANT_ID, () => reportMarketTelemetry(event, { serverDB, userId: 'u1' }, deps));

    expect(sentUrl(fetchMock)).toBe('https://market.test/api/v1/telemetry/events');
  });

  it('never reports a tenant user under a bearer token, even when one is at hand', async () => {
    const { deps, fetchMock } = makeDeps();

    await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(
        report,
        { marketAccessToken: 'oidc-user-token', serverDB, userId: 'u1' },
        deps,
      ),
    );

    expect(sentHeaders(fetchMock)).not.toHaveProperty('Authorization');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('oidc-user-token');
  });

  describe('when the identity cannot be assembled', () => {
    it('does not report, and does not fall back to a bearer token or to default', async () => {
      userRow.current = undefined;
      const { deps, fetchMock } = makeDeps();

      const result = await inTenant(TENANT_ID, () =>
        reportMarketTelemetry(
          report,
          { marketAccessToken: 'oidc-user-token', serverDB, userId: 'u1' },
          deps,
        ),
      );

      expect(result).toMatchObject({ reason: 'identity', status: 'skipped' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not report from outside any tenant when trusted client is configured', async () => {
      const { deps, fetchMock } = makeDeps();

      const result = await reportMarketTelemetry(
        report,
        { marketAccessToken: 'oidc-user-token', serverDB, userId: 'u1' },
        deps,
      );

      expect(result).toMatchObject({ reason: 'identity', status: 'skipped' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not report from a tenant that has no trusted client to sign with', async () => {
      appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;
      const { deps, fetchMock } = makeDeps();

      const result = await inTenant(TENANT_ID, () =>
        reportMarketTelemetry(
          report,
          { marketAccessToken: 'm2m-token', serverDB, userId: 'u1' },
          deps,
        ),
      );

      expect(result).toMatchObject({ reason: 'identity', status: 'skipped' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not report for a synthetic eval user', async () => {
      const { deps, fetchMock } = makeDeps();

      const result = await inTenant(TENANT_ID, () =>
        reportMarketTelemetry(report, { serverDB, userId: 'eval_abc' }, deps),
      );

      expect(result.status).toBe('skipped');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('reportMarketTelemetry: without a tenant', () => {
  beforeEach(() => {
    appEnv.MARKET_TRUSTED_CLIENT_ID = undefined;
    appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;
  });

  it('keeps reporting with the user token a community deployment has', async () => {
    const { deps, fetchMock } = makeDeps();

    const result = await reportMarketTelemetry(
      report,
      { marketAccessToken: 'm2m-token', serverDB, userId: 'u1' },
      deps,
    );

    expect(result.status).toBe('delivered');
    expect(sentHeaders(fetchMock).Authorization).toBe('Bearer m2m-token');
    expect(sentHeaders(fetchMock)).not.toHaveProperty('x-lobe-trust-token');
  });

  it('has nothing to authenticate with, and says so, when there is no token', async () => {
    const { deps, fetchMock } = makeDeps();

    const result = await reportMarketTelemetry(report, { serverDB, userId: 'u1' }, deps);

    expect(result).toMatchObject({ reason: 'no-credentials', status: 'skipped' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('reportMarketTelemetry: delivery', () => {
  it('retries a network failure with the very same event', async () => {
    const { deps, fetchMock } = makeDeps(new TypeError('fetch failed'), response(201));

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB, userId: 'u1' }, deps),
    );

    expect(result).toMatchObject({ attempts: 2, status: 'delivered' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchMock, 1)).toBe(sentBody(fetchMock, 0));
    expect(JSON.parse(sentBody(fetchMock, 1)).eventId).toBe('v1:call:op:tc:1');
  });

  it('issues a fresh token for every send, and the token is not part of the event', async () => {
    const { deps, fetchMock } = makeDeps(response(503), response(201));

    await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB, userId: 'u1' }, deps),
    );

    expect(sentHeaders(fetchMock, 0)['x-lobe-trust-token']).toBe('client-id.signed-token-1');
    expect(sentHeaders(fetchMock, 1)['x-lobe-trust-token']).toBe('client-id.signed-token-2');
    expect(sentBody(fetchMock, 0)).not.toContain('signed-token');
    expect(JSON.stringify(report)).not.toContain('signed-token');
  });

  it.each([429, 500, 502, 503])('retries on %s', async (status) => {
    const { deps, fetchMock } = makeDeps(response(status, {}), response(200, { duplicate: true }));

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB, userId: 'u1' }, deps),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ duplicate: true, status: 'delivered' });
  });

  // A 4xx is Market's answer about this event; another try would be the same question.
  it.each([
    [400, 'INVALID_INPUT'],
    [401, 'INVALID_TRUST_TOKEN'],
    [403, 'CLIENT_TENANT_MISMATCH'],
    [409, 'EVENT_ID_CONFLICT'],
  ])('does not retry %s', async (status, code) => {
    const { deps, fetchMock } = makeDeps(response(status, { error: { code, message: 'no' } }));

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB, userId: 'u1' }, deps),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ errorCode: code, httpStatus: status, status: 'failed' });
  });

  it('gives up after a bounded number of tries and does not throw', async () => {
    const { deps, fetchMock } = makeDeps(
      response(503),
      response(503),
      response(503),
      response(503),
    );

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB, userId: 'u1' }, deps),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ attempts: 3, status: 'failed' });
  });

  it('reports a duplicate acknowledgement as delivered', async () => {
    const { deps } = makeDeps(response(200, { duplicate: true, success: true }));

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB, userId: 'u1' }, deps),
    );

    expect(result).toMatchObject({ duplicate: true, status: 'delivered' });
  });

  it('turns a failure to sign into a skip rather than a throw', async () => {
    vi.mocked(createTrustedClientToken).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const { deps, fetchMock } = makeDeps();

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB, userId: 'u1' }, deps),
    );

    expect(result.status).toBe('skipped');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The signer now raises its own named failure instead of returning "no
  // token"; the reporter still skips, sends nothing and never falls back.
  it('skips, without a bearer fallback, when the signer raises a named failure', async () => {
    vi.mocked(createTrustedClientToken).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const { deps, fetchMock } = makeDeps();

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(
        report,
        { marketAccessToken: 'oidc-user-token', serverDB, userId: 'u1' },
        deps,
      ),
    );

    expect(result).toMatchObject({ reason: 'identity', status: 'skipped' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when the trusted client is not configured in a tenant, as before', async () => {
    appEnv.MARKET_TRUSTED_CLIENT_ID = undefined;
    const { deps, fetchMock } = makeDeps();

    const result = await inTenant(TENANT_ID, () =>
      reportMarketTelemetry(report, { serverDB, userId: 'u1' }, deps),
    );

    expect(result).toMatchObject({ reason: 'identity', status: 'skipped' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
