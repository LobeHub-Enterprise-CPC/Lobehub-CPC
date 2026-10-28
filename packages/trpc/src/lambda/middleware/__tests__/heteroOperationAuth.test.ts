import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { exportJWK, generateKeyPair } from 'jose';
import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { auth } from '@/auth';
import { createCallerFactory, heteroAuthedProcedure, router } from '@/libs/trpc/lambda';

import { signHeteroOperationJWT } from '../../../utils/internalJwt';
import { createLambdaContext } from '../../context';

const { mockAuthEnv } = vi.hoisted(() => ({
  mockAuthEnv: {
    ENABLE_OIDC: true,
    JWKS_KEY: '',
  },
}));

vi.mock('@/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@/business/server/workspaceApiKey', () => ({
  canUseWorkspaceApiKeys: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/database/models/apiKey', () => ({
  ApiKeyModel: vi.fn(),
}));

vi.mock('@/database/models/workspace', () => ({
  hasActiveWorkspaceMembership: vi.fn(),
}));

vi.mock('@/envs/auth', () => ({
  LOBE_CHAT_OIDC_AUTH_HEADER: 'Oidc-Auth',
  authEnv: mockAuthEnv,
}));

vi.mock('@/libs/observability/traceparent', () => ({
  extractTraceContext: vi.fn(),
  injectSpanTraceHeaders: vi.fn(),
}));

vi.mock('@/libs/oidc-provider/access-control', () => ({
  assertOIDCUserActive: vi.fn(),
  isOIDCUserInactiveError: vi.fn().mockReturnValue(false),
}));

// Minimal router that exercises heteroOperationAuth
const testRouter = router({
  ping: heteroAuthedProcedure.query(({ ctx }) => ({
    kind: ctx.heteroAuthKind,
    operation: ctx.heteroOperation,
    userId: ctx.userId,
  })),
});

const createCaller = createCallerFactory(testRouter);

const inTenant = <T>(tenantId: string, operation: () => Promise<T>) =>
  runWithTenantScope({ slug: tenantId, tenantId } as TenantScope, operation);

const operationToken = () =>
  signHeteroOperationJWT({
    capabilities: ['model:invoke'],
    model: 'gpt-server',
    operationId: 'op-1',
    providerId: 'openai',
    userId: 'user-abc',
    workspaceId: 'workspace-123',
  });

const pingWithToken = (token: string) =>
  createLambdaContext(
    new NextRequest('https://example.com/trpc/lambda', { headers: { 'Oidc-Auth': token } }),
  ).then((ctx) => createCaller(ctx).ping());

describe('heteroOperationAuth middleware', () => {
  beforeAll(async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    mockAuthEnv.JWKS_KEY = JSON.stringify({
      keys: [{ ...privateJwk, alg: 'RS256', kid: 'test-kid', use: 'sig' }],
    });
  });

  it('accepts a hetero-operation token as kind "operation" in the tenant that issued it', async () => {
    const token = await inTenant('tenant-a', operationToken);

    const result = await inTenant('tenant-a', () => pingWithToken(token));

    expect(result).toEqual({
      kind: 'operation',
      operation: expect.objectContaining({
        capabilities: ['model:invoke'],
        iss: 'urn:lobehub:internal',
        model: 'gpt-server',
        operation_id: 'op-1',
        provider_id: 'openai',
        tid: 'tenant-a',
        workspace_id: 'workspace-123',
      }),
      userId: 'user-abc',
    });
  });

  it('does not authenticate a hetero-operation token issued by another tenant', async () => {
    const token = await inTenant('tenant-a', operationToken);
    // Rejected OIDC falls through to the session login, which has no session here.
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      headers: new Headers(),
      response: null,
    } as never);

    await expect(inTenant('tenant-b', () => pingWithToken(token))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it.each([
    ['without operation claims', { purpose: 'hetero-operation', sub: 'user-abc' }],
    [
      'with a partial operation contract',
      { operation_id: 'op-1', purpose: 'hetero-operation', sub: 'user-abc' },
    ],
  ])('rejects an operation token %s', async (_case, oidcAuth) => {
    const caller = createCaller({ oidcAuth } as any);

    await expect(caller.ping()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('accepts a normal user OIDC token (no purpose) as kind "user"', async () => {
    const caller = createCaller({
      oidcAuth: { sub: 'user-abc' },
    } as any);

    const result = await caller.ping();

    expect(result).toEqual({ kind: 'user', operation: undefined, userId: 'user-abc' });
  });

  it('accepts a cli-sandbox token as kind "user"', async () => {
    const caller = createCaller({
      oidcAuth: { purpose: 'cli-sandbox', sub: 'user-abc' },
    } as any);

    const result = await caller.ping();

    expect(result).toEqual({ kind: 'user', operation: undefined, userId: 'user-abc' });
  });

  it('rejects when oidcAuth is absent', async () => {
    const caller = createCaller({} as any);

    await expect(caller.ping()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects when oidcAuth has no sub', async () => {
    const caller = createCaller({
      oidcAuth: { purpose: 'hetero-operation' },
    } as any);

    await expect(caller.ping()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
