import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { App } from '@/core/App';

import RemoteServerSyncCtr from '../RemoteServerSyncCtr';

const { httpsRequestMock, ipcMainOnMock } = vi.hoisted(() => ({
  httpsRequestMock: vi.fn(),
  ipcMainOnMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.2.3') },
  ipcMain: { handle: vi.fn(), on: ipcMainOnMock },
}));
vi.mock('node:https', () => ({ default: { request: httpsRequestMock } }));
vi.mock('../RemoteServerConfigCtr', () => ({ default: class {} }));

describe('RemoteServerSyncCtr tRPC stream forwarding', () => {
  let remoteServerUrl: string;
  let sender: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };

  const start = async (urlPath: string) => {
    const controller = new RemoteServerSyncCtr({
      getController: () => ({
        getAccessToken: async () => 'token',
        getRemoteServerUrl: async () => remoteServerUrl,
        isRemoteServerConfigured: async () => true,
      }),
      storeManager: { get: (_key: string, fallback: unknown) => fallback },
    } as unknown as App);
    controller.afterAppReady();

    const handler = ipcMainOnMock.mock.calls.find(([channel]) => channel === 'stream:start')![1];
    await handler({ sender }, { headers: {}, method: 'GET', requestId: 'req-1', urlPath });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sender = { isDestroyed: () => false, send: vi.fn() };
    httpsRequestMock.mockImplementation(() =>
      Object.assign(new EventEmitter(), { end: vi.fn(), write: vi.fn() }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['https://host.example/orgs/acme', 'https://host.example/orgs/acme/'])(
    'forwards the request under the tenant path prefix of %s',
    async (url) => {
      remoteServerUrl = url;
      await start('/trpc/lambda/chat.stream?batch=1');

      const options = httpsRequestMock.mock.calls[0][0];
      expect(options.hostname).toBe('host.example');
      expect(options.path).toBe('/orgs/acme/trpc/lambda/chat.stream?batch=1');
    },
  );

  it('keeps the root path for a custom-domain root address', async () => {
    remoteServerUrl = 'https://custom.example';
    await start('/trpc/lambda/chat.stream');

    expect(httpsRequestMock.mock.calls[0][0].path).toBe('/trpc/lambda/chat.stream');
  });

  it('refuses to forward a path that names another origin', async () => {
    remoteServerUrl = 'https://host.example/orgs/acme';
    await start('//evil.example/trpc');

    expect(httpsRequestMock).not.toHaveBeenCalled();
    expect(sender.send).toHaveBeenCalledWith('stream:error:req-1', expect.any(Error));
  });
});
