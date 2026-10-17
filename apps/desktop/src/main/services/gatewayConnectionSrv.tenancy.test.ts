import type { GatewayClient, ToolCallRequestMessage } from '@lobechat/device-gateway-client';
import { describe, expect, it, vi } from 'vitest';

import type { App } from '@/core/App';

import zhCnCommon from '../../../resources/locales/zh-CN/common.json';
import GatewayConnectionService from './gatewayConnectionSrv';

const socketState = vi.hoisted(() => ({ constructs: 0 }));
vi.mock('@lobechat/device-gateway-client', () => ({
  GatewayClient: class {
    constructor() {
      socketState.constructs++;
    }
    on() {}
    async connect() {}
  },
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '0-test' },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
}));

const request = (current: () => boolean): ToolCallRequestMessage => ({
  attemptId: 'attempt-original',
  executionSignal: new AbortController().signal,
  isExecutionCurrent: current,
  requestId: 'same-request',
  toolCall: { apiName: 'writeFile', arguments: '{}', identifier: 'local' },
  type: 'tool_call_request',
});

describe('desktop gateway execution boundary', () => {
  it('does not execute a dequeued request whose authority expired', async () => {
    const service = new GatewayConnectionService({} as App);
    const execute = vi.fn();
    service.setToolCallHandler(execute);
    const send = vi.fn();
    await (service as any).handleToolCallRequest(
      request(() => false),
      { sendToolCallResponse: send } as unknown as GatewayClient,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('echoes the original attempt and forwards cancellation to execution', async () => {
    const service = new GatewayConnectionService({} as App);
    const execute = vi.fn().mockResolvedValue({ content: 'done', success: true });
    service.setToolCallHandler(execute);
    const send = vi.fn();
    const command = request(() => true);
    await (service as any).handleToolCallRequest(command, {
      sendToolCallResponse: send,
    } as unknown as GatewayClient);
    expect(send.mock.calls[0][0]).toMatchObject({
      attemptId: command.attemptId,
      requestId: command.requestId,
    });
    expect(execute.mock.calls[0][3]).toBe(command.executionSignal);
  });
});

describe('desktop workspace sharing rejection', () => {
  it('explains the device account admin requirement and does not persist or connect the share', async () => {
    const set = vi.fn();
    const message = zhCnCommon['gateway.workspaceAdminRequired'];
    const service = new GatewayConnectionService({
      storeManager: { get: vi.fn(), set },
      i18n: { ns: () => () => message },
    } as unknown as App);
    (service as any).client = {};
    service.setIdentityProviderFactory(async () => async () => {
      throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN', status: 403 });
    });
    await expect(
      service.enrollWorkspace({ workspaceId: 'workspace', token: 'web-session-hint' }),
    ).rejects.toThrow(message);
    expect(set).not.toHaveBeenCalled();
    expect((service as any).workspaceClients.size).toBe(0);
  });
});

describe('desktop pending connection generation', () => {
  it('does not open a socket or write identity after a mint returns following logout', async () => {
    const service = new GatewayConnectionService({
      browserManager: { broadcastToAllWindows: vi.fn() },
      storeManager: { get: (_key: string, fallback: unknown) => fallback, set: vi.fn() },
    } as unknown as App);
    let release!: (identity: unknown) => void;
    const provider = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    service.setIdentityProviderFactory(async () => provider as any);
    const pending = service.connect();
    await vi.waitFor(() => expect(release).toBeDefined());
    await service.disconnect();
    release({ userId: 'same-sub', tenantId: 'tenant-A', gatewayTicket: 'late-ticket' });
    expect((await pending).success).toBe(false);
    expect(service.getStatus()).toBe('disconnected');
    expect((service as any).client).toBeNull();
    expect((service as any).enrollmentIdentity).toBeUndefined();
  });
});

describe('desktop pending workspace device identity', () => {
  it('does not create a workspace socket after cancellation during device identity resolution', async () => {
    socketState.constructs = 0;
    const service = new GatewayConnectionService({
      storeManager: { get: (_key: string, fallback: unknown) => fallback, set: vi.fn() },
    } as unknown as App);
    (service as any).client = {};
    service.setIdentityProviderFactory(
      async () => async () => ({ gatewayTicket: 'own-source' }) as any,
    );
    let release!: (value: unknown) => void;
    vi.spyOn(service as any, 'resolveWorkspaceDeviceIdentity').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = (service as any).openWorkspaceClient('workspace');
    await vi.waitFor(() => expect(release).toBeDefined());
    await (service as any).closeWorkspaceClient('workspace');
    release({ deviceId: 'device', connectionId: 'connection' });
    await expect(pending).rejects.toThrow();
    expect(socketState.constructs).toBe(0);
    expect((service as any).workspaceClients.size).toBe(0);
  });
});
