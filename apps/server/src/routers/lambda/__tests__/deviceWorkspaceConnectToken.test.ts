// @vitest-environment node
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runWithGatewaySource } from '@/server/services/gatewayAuthorization/context';
import { GatewayAuthorizationError } from '@/server/services/gatewayAuthorization/wire';

import { deviceRouter } from '../device';
import { mintWorkspaceDeviceConnectToken } from '../deviceWorkspaceConnectToken';

const mocks = vi.hoisted(() => ({
  enrollWorkspace: vi.fn(),
  findByDeviceId: vi.fn(),
  registerWorkspaceDevice: vi.fn(),
  signWorkspaceDeviceToken: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(() => ({})) }));
vi.mock('@/database/models/device', () => ({
  DeviceModel: class {
    findByDeviceId = mocks.findByDeviceId;
    registerWorkspaceDevice = mocks.registerWorkspaceDevice;
  },
}));
vi.mock('@/libs/trpc/utils/internalJwt', () => ({
  signTunnelAccessToken: vi.fn(),
  signWorkspaceDeviceToken: mocks.signWorkspaceDeviceToken,
}));
vi.mock('@/server/services/deviceGateway', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deviceGateway: { enrollWorkspace: mocks.enrollWorkspace },
}));

const source = { kind: 'session' as const, sessionId: 'session', subject: 'user' };
const context = (workspaceRole: 'member' | 'owner' = 'member', withSource = true) => ({
  gatewaySource: withSource ? source : undefined,
  userId: 'user',
  workspaceId: 'workspace',
  workspaceRole,
});
const caller = (withSource = true) =>
  deviceRouter.createCaller(context('member', withSource) as never);
const request = (procedure: string, input: unknown = null, withSource = true) =>
  fetchRequestHandler({
    createContext: () => context('member', withSource) as never,
    endpoint: '/trpc',
    req: new Request(`http://localhost/trpc/${procedure}`, {
      body: JSON.stringify({ json: input }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
    router: deviceRouter,
  });

describe('workspace device connect token error boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findByDeviceId.mockResolvedValue({ deviceId: 'personal', workspaceId: null });
    mocks.signWorkspaceDeviceToken.mockResolvedValue('connect-ticket');
  });

  it('returns HTTP 403 for the signer denial without exposing it as an internal error', async () => {
    mocks.signWorkspaceDeviceToken.mockRejectedValue(
      new GatewayAuthorizationError('FORBIDDEN', 403),
    );
    const response = await request('mintWorkspaceConnectToken');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { json: { data: { code: 'FORBIDDEN', httpStatus: 403 }, message: 'FORBIDDEN' } },
    });
  });

  it('maps the synchronous missing request source to HTTP 401 before signing', async () => {
    const response = await request('mintWorkspaceConnectToken', null, false);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { json: { data: { code: 'UNAUTHORIZED' }, message: 'SOURCE_UNVERIFIABLE' } },
    });
    expect(mocks.signWorkspaceDeviceToken).not.toHaveBeenCalled();
  });

  it('rejects sharing before the device probe or registration', async () => {
    const error = new GatewayAuthorizationError('FORBIDDEN', 403);
    mocks.signWorkspaceDeviceToken.mockRejectedValue(error);
    const response = await request('shareDeviceToWorkspace', { deviceId: 'personal' });
    expect(response.status).toBe(403);
    expect(mocks.enrollWorkspace).not.toHaveBeenCalled();
    expect(mocks.registerWorkspaceDevice).not.toHaveBeenCalled();
  });

  it('preserves the Owner success DTO and the original request source', async () => {
    const owner = deviceRouter.createCaller(context('owner') as never);
    await expect(owner.mintWorkspaceConnectToken()).resolves.toEqual({
      token: 'connect-ticket',
      workspaceId: 'workspace',
    });
    expect(mocks.signWorkspaceDeviceToken).toHaveBeenCalledExactlyOnceWith('workspace', source);
  });

  it.each([
    [400, 'BAD_REQUEST'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [501, 'NOT_IMPLEMENTED'],
    [503, 'SERVICE_UNAVAILABLE'],
  ] as const)('preserves the typed denial status %i and its cause', async (status, code) => {
    const error = new GatewayAuthorizationError('DOMAIN_DENIAL', status);
    mocks.signWorkspaceDeviceToken.mockRejectedValue(error);
    const caught = await caller()
      .mintWorkspaceConnectToken()
      .catch((failure: unknown) => failure);
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught).toMatchObject({ cause: error, code, message: 'DOMAIN_DENIAL' });
    expect((caught as TRPCError).cause).toBe(error);
    expect(getHTTPStatusCodeFromError(caught as TRPCError)).toBe(status);
  });

  it('preserves an existing tRPC error object', async () => {
    const error = new TRPCError({ code: 'PRECONDITION_FAILED', message: 'existing' });
    mocks.signWorkspaceDeviceToken.mockRejectedValue(error);
    await expect(caller().mintWorkspaceConnectToken()).rejects.toBe(error);
  });

  it.each([
    new Error('unknown'),
    Object.assign(new Error('not a gateway authorization error'), { status: 403 }),
    new GatewayAuthorizationError('UNMAPPED', 418),
  ])('leaves an unknown failure as HTTP 500 with its original cause', async (error) => {
    mocks.signWorkspaceDeviceToken.mockRejectedValue(error);
    await expect(
      runWithGatewaySource(source, () => mintWorkspaceDeviceConnectToken('workspace', 'user')),
    ).rejects.toBe(error);
    const caught = await caller()
      .mintWorkspaceConnectToken()
      .catch((failure: unknown) => failure);
    expect(caught).toMatchObject({ cause: error, code: 'INTERNAL_SERVER_ERROR' });
    expect((caught as TRPCError).cause).toBe(error);
    expect(getHTTPStatusCodeFromError(caught as TRPCError)).toBe(500);
  });
});
