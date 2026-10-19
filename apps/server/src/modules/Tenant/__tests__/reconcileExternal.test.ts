// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { tenantDirectory } from '@lobechat/database/platform';
import { SUPPORTED_TENANT_SCHEMA_VERSIONS, tenantDbNames } from '@lobechat/database/tenant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reconcileExternalWork } from '../reconcileExternal';

const state = vi.hoisted(() => ({
  baseURL: '',
  directory: undefined as any,
  /** What the Market SDK received: the signed payloads and the tokens sent. */
  market: { payloads: [] as any[], tokens: [] as string[] },
  runBuildInTool: vi.fn(),
  userFindById: vi.fn(),
  work: undefined as any,
  write: vi.fn(),
}));
vi.mock('@/envs/sandbox', () => ({
  sandboxEnv: {
    get ONLYBOXES_BASE_URL() {
      return state.baseURL;
    },
    ONLYBOXES_JIT_SIGNING_KEY: 'local-fixture',
  },
}));
// The tenant business database the operator opens (read-only) to look a user up.
vi.mock('pg', () => ({
  Pool: class {
    connect = async () => ({ release: () => {} });
    end = async () => {};
  },
}));
vi.mock('@/server/modules/Tenant/verifyDatabase', () => ({
  verifyRuntimeTenantDatabase: async () => {},
}));
vi.mock('../endpoints', () => ({ loadTenantPublicEndpoint: async () => ({}) }));
vi.mock('@/server/crypto/tenantKeys', () => ({ openDirectoryData: () => '{}' }));
vi.mock('@/database/models/user', () => ({ UserModel: { findById: state.userFindById } }));
vi.mock('@/envs/app', async (original) => ({
  ...(await original<object>()),
  appEnv: {
    MARKET_TRUSTED_CLIENT_ID: 'client-id',
    MARKET_TRUSTED_CLIENT_SECRET: 'client-secret',
  },
}));
// Market authenticates the trust token's payload; its schema needs a real email.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/;
vi.mock('@lobehub/market-sdk', () => ({
  buildTrustedClientPayload: (params: Record<string, unknown>) => ({
    ...params,
    nonce: 'n',
    timestamp: 0,
  }),
  createTrustedClientToken: (payload: unknown) => {
    state.market.payloads.push(payload);
    return `token-${state.market.payloads.length}`;
  },
  MarketSDK: class {
    plugins = {
      runBuildInTool: async (...args: unknown[]) => {
        const payload = state.market.payloads.at(-1);
        if (!EMAIL_PATTERN.test(payload?.email ?? '')) throw new Error('invalid_trust_token');
        return state.runBuildInTool(...args);
      },
    };
    constructor(options: { trustedClientToken?: string }) {
      if (options.trustedClientToken) state.market.tokens.push(options.trustedClientToken);
    }
  },
}));
vi.mock('@lobechat/database/platform', async (original) => ({
  ...(await original<object>()),
  getPlatformDB: () => {
    let table: unknown;
    const query: any = {
      from: (target: unknown) => {
        table = target;
        return query;
      },
      where: () => query,
      limit: async () =>
        table === tenantDirectory ? [state.directory] : state.work ? [state.work] : [],
    };
    return {
      select: () => query,
      update: () => ({ set: (value: unknown) => ({ where: async () => state.write(value) }) }),
    };
  },
}));
// Market only accepts a canonical UUID as the signed tenant id (the id Console generates).
const BETA = '00000000-0000-4000-8000-0000000000b1';
const ALPHA = '00000000-0000-4000-8000-0000000000a1';

describe('operator reconciliation against a local HTTP provider', () => {
  let server: Server;
  let status: string | undefined;
  let httpStatus: number;
  beforeEach(async () => {
    vi.clearAllMocks();
    status = 'running';
    httpStatus = 200;
    state.market.payloads = [];
    state.market.tokens = [];
    state.directory = {
      credentialBundleVersion: 1,
      database: 'db',
      host: 'localhost',
      port: 5432,
      runtimeSecret: 'sealed',
      runtimeUsername: tenantDbNames(BETA).runtimeUsername,
      schemaName: tenantDbNames(BETA).schemaName,
      schemaVersion: [...SUPPORTED_TENANT_SCHEMA_VERSIONS][0],
      slug: 'beta',
      tls: { enabled: false },
    };
    state.work = {
      workId: 'sandbox:fixture',
      tenantId: BETA,
      kind: 'sandbox',
      handle: JSON.stringify([BETA, 'onlyboxes', 'user', 'topic', null, 'remote-command']),
    };
    server = createServer((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/api/v1/tasks/remote-command');
      res.writeHead(httpStatus, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it.each(['running', 'pending', undefined, 'unknown'])(
    'retains unresolved work with state %s',
    async (remoteState) => {
      status = remoteState;
      expect(await reconcileExternalWork('sandbox:fixture')).toMatchObject({ terminal: false });
      expect(state.write).not.toHaveBeenCalled();
    },
  );
  it.each([404, 500])('does not infer destruction from HTTP %s', async (code) => {
    httpStatus = code;
    expect(await reconcileExternalWork('sandbox:fixture')).toMatchObject({ terminal: false });
    expect(state.write).not.toHaveBeenCalled();
  });
  it.each(['succeeded', 'failed', 'cancelled'])(
    'stores positive terminal evidence for %s',
    async (remoteState) => {
      status = remoteState;
      expect(await reconcileExternalWork('sandbox:fixture')).toMatchObject({ terminal: true });
      expect(state.write).toHaveBeenCalledWith(
        expect.objectContaining({
          completedAt: expect.any(Date),
          receipt: expect.objectContaining({ source: 'operator-provider-query' }),
        }),
      );
    },
  );
  it('retains lost submissions without a provider lookup handle', async () => {
    state.work.handle = null;
    await expect(reconcileExternalWork('sandbox:fixture')).rejects.toThrow('HANDLE_UNKNOWN');
    expect(state.write).not.toHaveBeenCalled();
  });
  // The market token is signed from the receipt's identity alone, outside any
  // tenant scope, so a receipt that does not name this work's tenant must not
  // be replayed as one.
  it.each([
    ['another tenant', { tenantId: ALPHA, userId: 'user' }],
    ['no tenant (a receipt from before identities carried it)', { userId: 'user' }],
  ])('refuses a market receipt whose identity names %s', async (_label, identity) => {
    state.work = {
      workId: 'sandbox:fixture',
      tenantId: BETA,
      kind: 'sandbox',
      handle: JSON.stringify([BETA, 'market', 'user', 'topic', null, 'remote-command']),
      context: { identity, sealedSpecification: 'sealed' },
    };

    await expect(reconcileExternalWork('sandbox:fixture')).rejects.toThrow(
      'EXTERNAL_WORK_CONTEXT_MISSING',
    );
    expect(state.write).not.toHaveBeenCalled();
  });

  // Operator recovery re-signs the receipt's identity outside any request. The
  // receipt keeps no email (less persisted PII, and it follows an email change),
  // so the user is looked up again, in the work's own tenant, before signing.
  describe('re-signing a market receipt', () => {
    const marketWork = (
      identity: Record<string, unknown> = { tenantId: BETA, userId: 'user' },
    ) => ({
      context: { identity, sealedSpecification: 'sealed' },
      handle: JSON.stringify([BETA, 'market', 'user', 'topic', null, 'remote-command']),
      kind: 'sandbox',
      tenantId: BETA,
      workId: 'sandbox:fixture',
    });

    beforeEach(() => {
      state.work = marketWork();
      state.userFindById.mockResolvedValue({ email: 'owner@example.com', fullName: 'Owner' });
      state.runBuildInTool.mockResolvedValue({
        data: { result: { running: false } },
        success: true,
      });
    });

    it('signs the email it looks up now, and the provider call authenticates', async () => {
      await expect(reconcileExternalWork('sandbox:fixture')).resolves.toMatchObject({
        terminal: true,
      });

      expect(state.userFindById).toHaveBeenCalledWith(expect.anything(), 'user');
      expect(state.market.payloads).toHaveLength(1);
      expect(state.market.payloads[0]).toMatchObject({
        email: 'owner@example.com',
        tenantId: BETA,
        userId: 'user',
      });
      expect(state.runBuildInTool).toHaveBeenCalledWith(
        'getCommandOutput',
        { commandId: 'remote-command' },
        expect.anything(),
        expect.anything(),
      );
      expect(state.write).toHaveBeenCalledWith(
        expect.objectContaining({ completedAt: expect.any(Date) }),
      );
    });

    it('follows an email change instead of replaying an old one', async () => {
      state.userFindById.mockResolvedValue({ email: 'changed@example.com' });

      await reconcileExternalWork('sandbox:fixture');

      expect(state.market.payloads[0].email).toBe('changed@example.com');
    });

    it('never writes the email back into the receipt', async () => {
      await reconcileExternalWork('sandbox:fixture');

      expect(state.work.context.identity).toEqual({ tenantId: BETA, userId: 'user' });
      expect(JSON.stringify(state.write.mock.calls)).not.toContain('owner@example.com');
    });

    it.each([
      ['the user is gone', undefined],
      ['the user has no email', { email: null }],
    ])('fails closed, signing nothing, when %s', async (_label, row) => {
      state.userFindById.mockResolvedValue(row);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(reconcileExternalWork('sandbox:fixture')).rejects.toMatchObject({
        code: 'USER_UNAVAILABLE',
      });

      expect(state.market.payloads).toHaveLength(0);
      expect(state.runBuildInTool).not.toHaveBeenCalled();
      expect(state.write).not.toHaveBeenCalled();
      // The log carries the code, never the user.
      expect(JSON.stringify(errorSpy.mock.calls)).toContain('USER_UNAVAILABLE');
      errorSpy.mockRestore();
    });

    it('fails closed when the lookup itself fails', async () => {
      state.userFindById.mockRejectedValue(new Error('db down: password=hunter2'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(reconcileExternalWork('sandbox:fixture')).rejects.toMatchObject({
        code: 'USER_UNAVAILABLE',
      });

      expect(state.market.payloads).toHaveLength(0);
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('hunter2');
      errorSpy.mockRestore();
    });
  });
});
