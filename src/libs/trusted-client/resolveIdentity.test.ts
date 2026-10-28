import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { appEnv, findById } = vi.hoisted(() => ({
  appEnv: {
    MARKET_TRUSTED_CLIENT_ID: 'client-id' as string | undefined,
    MARKET_TRUSTED_CLIENT_SECRET: 'client-secret' as string | undefined,
  },
  findById: vi.fn(),
}));

vi.mock('@/envs/app', () => ({ appEnv }));
vi.mock('@/database/models/user', () => ({ UserModel: { findById } }));
vi.mock('@lobehub/market-sdk', () => ({
  buildTrustedClientPayload: vi.fn(),
  createTrustedClientToken: vi.fn(),
}));

const { resolveMarketServiceIdentity, resolveTrustedClientIdentity } =
  await import('./resolveIdentity');
const { TrustedClientIdentityError } = await import('./errors');

const db = {} as never;
const inTenant = <T>(tenantId: string, fn: () => T) =>
  runWithTenantScope({ session: {}, slug: tenantId, tenantId } as unknown as TenantScope, fn);

beforeEach(() => {
  vi.clearAllMocks();
  appEnv.MARKET_TRUSTED_CLIENT_ID = 'client-id';
  appEnv.MARKET_TRUSTED_CLIENT_SECRET = 'client-secret';
  findById.mockResolvedValue({
    email: 'ada@example.com',
    fullName: 'Ada Lovelace',
    id: 'user_1',
    username: 'ada',
  });
});

describe('resolveTrustedClientIdentity', () => {
  it('assembles { userId, email, name, tenantId } from the user row and the tenant scope', async () => {
    await expect(
      inTenant('tenant-a', () => resolveTrustedClientIdentity({ serverDB: db, userId: 'user_1' })),
    ).resolves.toEqual({
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      tenantId: 'tenant-a',
      userId: 'user_1',
    });
    expect(findById).toHaveBeenCalledWith(db, 'user_1');
  });

  it('takes the tenant from the scope, so the same user id differs per tenant', async () => {
    const a = await inTenant('tenant-a', () =>
      resolveTrustedClientIdentity({ serverDB: db, userId: 'user_1' }),
    );
    const b = await inTenant('tenant-b', () =>
      resolveTrustedClientIdentity({ serverDB: db, userId: 'user_1' }),
    );

    expect(a?.tenantId).toBe('tenant-a');
    expect(b?.tenantId).toBe('tenant-b');
  });

  it('does not read the user row when the session already supplied email and name', async () => {
    const identity = await inTenant('tenant-a', () =>
      resolveTrustedClientIdentity({ email: 'e@x.com', name: 'E', userId: 'user_1' }),
    );

    expect(identity).toMatchObject({ email: 'e@x.com', name: 'E', tenantId: 'tenant-a' });
    expect(findById).not.toHaveBeenCalled();
  });

  it('carries the routing facts the caller passes', async () => {
    const sandboxStorage = { key: 'wt-x', quotaBytes: 1 };
    const identity = await inTenant('tenant-a', () =>
      resolveTrustedClientIdentity({
        proxyExecution: true,
        sandboxStorage,
        serverDB: db,
        userId: 'user_1',
        workspaceId: 'wsp_1',
      }),
    );

    expect(identity).toMatchObject({ proxyExecution: true, sandboxStorage });
  });

  // R13: no acting-as-organization inside a tenant. The workspace is a local
  // routing fact; it must not reach the identity that gets signed.
  it('leaves the workspace out of a tenant identity', async () => {
    const identity = await inTenant('tenant-a', () =>
      resolveTrustedClientIdentity({ serverDB: db, userId: 'user_1', workspaceId: 'wsp_1' }),
    );

    expect(identity).toBeDefined();
    expect(identity).not.toHaveProperty('workspaceId');
  });

  // The two outcomes a caller must be able to tell apart.
  describe('not enabled versus failed', () => {
    it('does not demand a tenant, and answers undefined rather than an error, when trusted client is not enabled', async () => {
      appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;

      await expect(
        resolveTrustedClientIdentity({ serverDB: db, userId: 'user_1' }),
      ).resolves.toMatchObject({ email: 'ada@example.com', userId: 'user_1' });
      findById.mockResolvedValue(undefined);
      await expect(
        resolveTrustedClientIdentity({ serverDB: db, userId: 'user_1' }),
      ).resolves.toBeUndefined();
    });

    it('answers undefined for a synthetic eval user', async () => {
      await expect(
        resolveTrustedClientIdentity({ serverDB: db, userId: 'eval_1' }),
      ).resolves.toBeUndefined();
    });

    it('throws TENANT_REQUIRED outside a tenant scope', async () => {
      await expect(
        resolveTrustedClientIdentity({ serverDB: db, userId: 'user_1' }),
      ).rejects.toMatchObject({ code: 'TENANT_REQUIRED' });
      expect(findById).not.toHaveBeenCalled();
    });

    it('throws USER_UNAVAILABLE when the user row is gone or has no email', async () => {
      findById.mockResolvedValue(undefined);
      await expect(
        inTenant('tenant-a', () =>
          resolveTrustedClientIdentity({ serverDB: db, userId: 'user_1' }),
        ),
      ).rejects.toMatchObject({ code: 'USER_UNAVAILABLE' });

      findById.mockResolvedValue({ email: null, id: 'user_1' });
      await expect(
        inTenant('tenant-a', () =>
          resolveTrustedClientIdentity({ serverDB: db, userId: 'user_1' }),
        ),
      ).rejects.toBeInstanceOf(TrustedClientIdentityError);
    });

    it('throws USER_UNAVAILABLE, with the cause, when the lookup itself fails', async () => {
      const cause = new Error('connection reset');
      findById.mockRejectedValue(cause);

      await expect(
        inTenant('tenant-a', () =>
          resolveTrustedClientIdentity({ serverDB: db, userId: 'user_1' }),
        ),
      ).rejects.toMatchObject({ cause, code: 'USER_UNAVAILABLE' });
    });
  });
});

describe('resolveMarketServiceIdentity', () => {
  it('returns the assembled identity when there is one', async () => {
    await expect(
      inTenant('tenant-a', () => resolveMarketServiceIdentity({ serverDB: db, userId: 'user_1' })),
    ).resolves.toMatchObject({ tenantId: 'tenant-a', userId: 'user_1' });
  });

  it('keeps the bare shape callers always passed when trusted client is not applicable', async () => {
    appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;
    findById.mockResolvedValue(undefined);

    await expect(
      resolveMarketServiceIdentity({ serverDB: db, userId: 'user_1', workspaceId: 'wsp_1' }),
    ).resolves.toEqual({ userId: 'user_1', workspaceId: 'wsp_1' });
  });

  it('keeps the workspace out of the bare shape too once trusted client is enabled', async () => {
    const identity = await inTenant('tenant-a', () =>
      resolveMarketServiceIdentity({ serverDB: db, userId: 'eval_1', workspaceId: 'wsp_1' }),
    );

    expect(identity).toEqual({ userId: 'eval_1' });
  });

  it('does not turn an assembly failure into the bare shape', async () => {
    await expect(
      resolveMarketServiceIdentity({ serverDB: db, userId: 'user_1' }),
    ).rejects.toMatchObject({ code: 'TENANT_REQUIRED' });
  });
});

describe('resolveTrustedClientIdentity in tenant mode without a usable trusted client', () => {
  it.each(['secret', 'id'] as const)(
    'throws TRUST_NOT_CONFIGURED when a tenant scope runs and the %s is missing',
    async (missing) => {
      if (missing === 'secret') appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;
      else appEnv.MARKET_TRUSTED_CLIENT_ID = undefined;

      await expect(
        inTenant('tenant-a', () =>
          resolveTrustedClientIdentity({ serverDB: db, userId: 'user_1' }),
        ),
      ).rejects.toMatchObject({ code: 'TRUST_NOT_CONFIGURED' });
      await expect(
        inTenant('tenant-a', () =>
          resolveMarketServiceIdentity({ serverDB: db, userId: 'user_1' }),
        ),
      ).rejects.toMatchObject({ code: 'TRUST_NOT_CONFIGURED' });
    },
  );

  it('keeps the legacy shape outside a tenant when nothing is configured', async () => {
    appEnv.MARKET_TRUSTED_CLIENT_SECRET = undefined;
    appEnv.MARKET_TRUSTED_CLIENT_ID = undefined;

    await expect(
      resolveTrustedClientIdentity({ serverDB: db, userId: 'user_1' }),
    ).resolves.toMatchObject({ userId: 'user_1' });
  });
});
