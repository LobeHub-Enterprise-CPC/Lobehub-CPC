import type { DataSyncConfig } from '@lobechat/electron-client-ipc';
import { BrowserWindow, shell } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { App } from '@/core/App';
import type { AuthFlowHost } from '@/modules/tenantAuth/AuthFlowManager';
import GatewayConnectionService from '@/services/gatewayConnectionSrv';

import AuthCtr from '../AuthCtr';
import RemoteServerConfigCtr from '../RemoteServerConfigCtr';

const { flowManagerMock, hostRef, ipcMainHandleMock } = vi.hoisted(() => ({
  flowManagerMock: {
    cancel: vi.fn(() => true),
    cancelConfirmation: vi.fn(() => ({ success: true })),
    confirm: vi.fn(async () => ({ success: true })),
    dispose: vi.fn(),
    getPendingRequest: vi.fn(() => null),
    hasActiveFlow: vi.fn(() => false),
    start: vi.fn(async () => ({ success: true })),
    startPlatform: vi.fn(async () => ({ success: true })),
    switchFromConfirmation: vi.fn(async () => ({ success: true })),
  },
  hostRef: { current: undefined as unknown },
  ipcMainHandleMock: vi.fn(),
}));

vi.mock('@/modules/tenantAuth/AuthFlowManager', () => ({
  AuthFlowManager: class {
    constructor(host: unknown) {
      hostRef.current = host;
      return flowManagerMock;
    }
  },
}));

// Mock electron
vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.2.3'),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    handle: ipcMainHandleMock,
  },
  net: {
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      global.fetch(input as any, init as any),
    ),
  },
  shell: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((str: string) => Buffer.from(str)),
    decryptString: vi.fn((buffer: Buffer) => buffer.toString()),
  },
}));

// Mock platform detection
vi.mock('@/utils/platform', () => ({
  macOS: vi.fn(() => false),
  windows: vi.fn(() => false),
  linux: vi.fn(() => false),
}));

vi.mock('@/const/env', () => ({
  OFFICIAL_CLOUD_SERVER: 'https://lobehub-cloud.com',
  isMac: false,
  isWindows: false,
  isLinux: false,
  isDev: false,
}));

const mockGatewaySrv = {
  connect: vi.fn().mockResolvedValue({ success: true }),
  disconnect: vi.fn().mockResolvedValue({ success: true }),
  // The real `restart` drops the previous identity's socket, then connects.
  restart: vi.fn(async () => {
    await mockGatewaySrv.disconnect();
    return mockGatewaySrv.connect();
  }),
};

const mockRemoteServerConfigCtr = {
  clearRemoteServerConfig: vi.fn().mockResolvedValue(true),
  clearTokens: vi.fn().mockResolvedValue(undefined),
  commitAuthorization: vi.fn().mockResolvedValue(undefined),
  getAccessToken: vi.fn().mockResolvedValue('mock-access-token'),
  getLastTokenRefreshAt: vi.fn().mockReturnValue(Date.now()),
  getPlatformOrigin: vi.fn().mockReturnValue('https://lobehub-cloud.com'),
  getRemoteServerConfig: vi.fn().mockResolvedValue({ active: true, storageMode: 'cloud' }),
  getTokenExpiresAt: vi.fn().mockReturnValue(Date.now() + 3600000),
  isNonRetryableError: vi.fn().mockReturnValue(false),
  isRemoteActivityPaused: vi.fn().mockReturnValue(false),
  isRemoteServerConfigured: vi.fn().mockResolvedValue(true),
  isTokenExpiringSoon: vi.fn().mockReturnValue(false),
  onLogout: vi.fn(),
  refreshAccessToken: vi.fn().mockResolvedValue({ success: true }),
  setRemoteServerConfig: vi.fn().mockResolvedValue(true),
} as unknown as RemoteServerConfigCtr;

const mockApp = {
  getController: vi.fn((ControllerClass) => {
    if (ControllerClass === RemoteServerConfigCtr) {
      return mockRemoteServerConfigCtr;
    }
    return null;
  }),
  getService: vi.fn((ServiceClass) =>
    ServiceClass === GatewayConnectionService ? mockGatewaySrv : null,
  ),
} as unknown as App;

describe('AuthCtr', () => {
  let authCtr: AuthCtr;
  let mockWindow: any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    ipcMainHandleMock.mockClear();
    hostRef.current = undefined;
    flowManagerMock.hasActiveFlow.mockReturnValue(false);
    vi.mocked(mockRemoteServerConfigCtr.isRemoteActivityPaused).mockReturnValue(false);
    vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(false);

    authCtr = new AuthCtr(mockApp);

    mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: {
        send: vi.fn(),
      },
    };
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow]);
  });

  afterEach(() => {
    authCtr?.cleanup?.();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const host = async () => {
    await authCtr.getPendingAuthorizationConfirmation();
    return hostRef.current as AuthFlowHost;
  };

  describe('authorization requests', () => {
    it('starts the flow from the given config', async () => {
      const config: DataSyncConfig = { storageMode: 'cloud' };

      const result = await authCtr.requestAuthorization(config);

      expect(result).toEqual({ success: true });
      expect(flowManagerMock.start).toHaveBeenCalledWith(config, { forceDiscovery: false });
    });

    it('forces a fresh discovery after a 409 paused the logged-in session', async () => {
      vi.mocked(mockRemoteServerConfigCtr.isRemoteActivityPaused).mockReturnValue(true);

      await authCtr.requestAuthorization({ storageMode: 'cloud' });

      expect(flowManagerMock.start).toHaveBeenCalledWith(
        { storageMode: 'cloud' },
        { forceDiscovery: true },
      );
    });

    it('reports an unexpected failure as a result, not an exception', async () => {
      flowManagerMock.start.mockRejectedValueOnce(new Error('boom'));

      expect(await authCtr.requestAuthorization({ storageMode: 'cloud' })).toEqual({
        code: 'UNKNOWN',
        error: 'boom',
        success: false,
      });
    });

    it('switching organization only starts a new platform flow in switch mode', async () => {
      await authCtr.switchOrganization();

      expect(flowManagerMock.startPlatform).toHaveBeenCalledWith({ switchOrganization: true });
      // The signed-in session keeps running until the new login is confirmed.
      expect(mockRemoteServerConfigCtr.clearRemoteServerConfig).not.toHaveBeenCalled();
      expect(mockRemoteServerConfigCtr.clearTokens).not.toHaveBeenCalled();
      expect(mockRemoteServerConfigCtr.setRemoteServerConfig).not.toHaveBeenCalled();
      expect(mockGatewaySrv.disconnect).not.toHaveBeenCalled();
    });

    it('does not stop the refresh timer when a new organization is being chosen', async () => {
      await authCtr.afterAppReady();
      await vi.advanceTimersByTimeAsync(0);
      vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(true);

      await authCtr.switchOrganization();
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(mockRemoteServerConfigCtr.refreshAccessToken).toHaveBeenCalled();
    });

    it('requestAuthorization takes the config as flow input and never persists it', async () => {
      const config: DataSyncConfig = {
        remoteServerUrl: 'https://other.example.com/t/b',
        storageMode: 'selfHost',
      };

      await authCtr.requestAuthorization(config);

      expect(mockRemoteServerConfigCtr.setRemoteServerConfig).not.toHaveBeenCalled();
      expect(mockRemoteServerConfigCtr.clearRemoteServerConfig).not.toHaveBeenCalled();
      expect(mockRemoteServerConfigCtr.clearTokens).not.toHaveBeenCalled();
    });

    it('requestPlatformAuthorization forwards the switch flag', async () => {
      await authCtr.requestPlatformAuthorization({ switchOrganization: true });
      await authCtr.requestPlatformAuthorization();

      expect(flowManagerMock.startPlatform).toHaveBeenNthCalledWith(1, {
        switchOrganization: true,
      });
      expect(flowManagerMock.startPlatform).toHaveBeenNthCalledWith(2, {
        switchOrganization: false,
      });
    });

    it('cancelAuthorization reports whether a flow was active', async () => {
      expect(await authCtr.cancelAuthorization()).toMatchObject({ success: false });

      flowManagerMock.hasActiveFlow.mockReturnValue(true);
      expect(await authCtr.cancelAuthorization()).toEqual({ success: true });
      expect(flowManagerMock.cancel).toHaveBeenCalled();
    });

    it('hands the confirmation calls to the flow manager unchanged', async () => {
      const params = { confirmationId: 'c', generation: 'g' };

      await authCtr.confirmAuthorization(params);
      await authCtr.cancelAuthorizationConfirmation(params);
      await authCtr.switchAuthorizationOrganization(params);

      expect(flowManagerMock.confirm).toHaveBeenCalledWith(params);
      expect(flowManagerMock.cancelConfirmation).toHaveBeenCalledWith(params);
      expect(flowManagerMock.switchFromConfirmation).toHaveBeenCalledWith(params);
    });

    it('opens market authorization URLs in the browser', async () => {
      expect(
        await authCtr.requestMarketAuthorization({ authUrl: 'https://market.example/auth' }),
      ).toEqual({
        success: true,
      });
      expect(shell.openExternal).toHaveBeenCalledWith('https://market.example/auth');
      expect(await authCtr.requestMarketAuthorization({ authUrl: '' })).toMatchObject({
        success: false,
      });
    });
  });

  describe('flow host wiring', () => {
    it('commits through the remote server config controller', async () => {
      const flowHost = await host();
      const params = { generation: 'g' } as Parameters<AuthFlowHost['commit']>[0];

      await flowHost.commit(params);

      expect(mockRemoteServerConfigCtr.commitAuthorization).toHaveBeenCalledWith(params);
    });

    it('only after the commit: starts auto-refresh and reconnects the gateway from scratch', async () => {
      const flowHost = await host();
      vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(true);

      // Nothing refreshes or connects before the commit callback runs.
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
      expect(mockRemoteServerConfigCtr.refreshAccessToken).not.toHaveBeenCalled();
      expect(mockGatewaySrv.connect).not.toHaveBeenCalled();

      flowHost.afterCommit();
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 100);

      expect(mockGatewaySrv.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
        mockGatewaySrv.connect.mock.invocationCallOrder[0],
      );
      expect(mockRemoteServerConfigCtr.refreshAccessToken).toHaveBeenCalled();
    });

    it('stops refreshing once a 409 paused the session', async () => {
      const flowHost = await host();
      vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(true);
      vi.mocked(mockRemoteServerConfigCtr.isRemoteActivityPaused).mockReturnValue(true);

      flowHost.afterCommit();
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(mockRemoteServerConfigCtr.refreshAccessToken).not.toHaveBeenCalled();
    });

    it('broadcasts to every live window', async () => {
      const flowHost = await host();

      flowHost.broadcast('authorizationConfirmRequired', { confirmationId: 'c' });

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('authorizationConfirmRequired', {
        confirmationId: 'c',
      });
    });

    it('cancels an in-flight authorization when the user logs out', () => {
      authCtr.afterAppReady();
      const [listener] = vi.mocked(mockRemoteServerConfigCtr.onLogout).mock.calls[0];

      listener();

      expect(flowManagerMock.cancel).toHaveBeenCalled();
    });
  });

  describe('Proactive Token Refresh', () => {
    beforeEach(() => {
      vi.mocked(mockRemoteServerConfigCtr.getRemoteServerConfig).mockResolvedValue({
        active: true,
        remoteServerUrl: 'https://lobehub-cloud.com',
        storageMode: 'cloud',
      });
      vi.mocked(mockRemoteServerConfigCtr.isRemoteServerConfigured).mockResolvedValue(true);
      vi.mocked(mockRemoteServerConfigCtr.getAccessToken).mockResolvedValue('mock-access-token');
      vi.mocked(mockRemoteServerConfigCtr.getTokenExpiresAt).mockReturnValue(
        Date.now() + 7 * 24 * 60 * 60 * 1000, // Token valid for 7 days
      );
      vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(false);
      vi.mocked(mockRemoteServerConfigCtr.refreshAccessToken).mockResolvedValue({ success: true });
      vi.mocked(mockRemoteServerConfigCtr.isNonRetryableError).mockReturnValue(false);
    });

    describe('onAppActivate', () => {
      it('should refresh token when it is expiring soon', async () => {
        vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(true);

        await authCtr.onAppActivate();

        expect(mockRemoteServerConfigCtr.refreshAccessToken).toHaveBeenCalled();
        expect(mockWindow.webContents.send).toHaveBeenCalledWith('tokenRefreshed');
      });

      it('should NOT refresh token when it is not expiring soon', async () => {
        vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(false);

        await authCtr.onAppActivate();

        expect(mockRemoteServerConfigCtr.refreshAccessToken).not.toHaveBeenCalled();
      });

      it('should check expiry with a small buffer, not the 24h default', async () => {
        vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(false);

        await authCtr.onAppActivate();

        const [buffer] = vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mock.calls[0];
        expect(buffer).toBeGreaterThan(0);
        expect(buffer).toBeLessThanOrEqual(60 * 60 * 1000);
      });

      it('should skip refresh when remote server is not active', async () => {
        vi.mocked(mockRemoteServerConfigCtr.isRemoteServerConfigured).mockResolvedValue(false);
        vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(true);

        await authCtr.onAppActivate();

        expect(mockRemoteServerConfigCtr.refreshAccessToken).not.toHaveBeenCalled();
      });

      it('should skip refresh when no access token exists', async () => {
        vi.mocked(mockRemoteServerConfigCtr.getAccessToken).mockResolvedValue(null);
        vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(true);

        await authCtr.onAppActivate();

        expect(mockRemoteServerConfigCtr.refreshAccessToken).not.toHaveBeenCalled();
      });

      it('should clear tokens and require re-auth on non-retryable error', async () => {
        vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(true);
        vi.mocked(mockRemoteServerConfigCtr.refreshAccessToken).mockResolvedValue({
          error: 'invalid_grant',
          success: false,
        });
        vi.mocked(mockRemoteServerConfigCtr.isNonRetryableError).mockReturnValue(true);

        await authCtr.onAppActivate();

        expect(mockRemoteServerConfigCtr.clearTokens).toHaveBeenCalled();
        expect(mockRemoteServerConfigCtr.setRemoteServerConfig).toHaveBeenCalledWith({
          active: false,
        });
        expect(mockWindow.webContents.send).toHaveBeenCalledWith(
          'authorizationRequired',
          expect.objectContaining({
            reason: expect.stringContaining('startup:non_retryable'),
          }),
        );
      });

      it('should preserve tokens on transient error', async () => {
        vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(true);
        vi.mocked(mockRemoteServerConfigCtr.refreshAccessToken).mockResolvedValue({
          error: 'network_error',
          success: false,
        });
        vi.mocked(mockRemoteServerConfigCtr.isNonRetryableError).mockReturnValue(false);

        await authCtr.onAppActivate();

        expect(mockRemoteServerConfigCtr.clearTokens).not.toHaveBeenCalled();
      });
    });

    describe('afterAppReady (initializeAutoRefresh)', () => {
      it('should proactively refresh on startup when token is expiring soon', async () => {
        vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(true);

        authCtr.afterAppReady();
        await vi.advanceTimersByTimeAsync(100);

        expect(mockRemoteServerConfigCtr.refreshAccessToken).toHaveBeenCalled();
      });

      it('should NOT refresh on startup when token is not expiring soon', async () => {
        vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(false);

        authCtr.afterAppReady();
        await vi.advanceTimersByTimeAsync(100);

        expect(mockRemoteServerConfigCtr.refreshAccessToken).not.toHaveBeenCalled();
      });

      it('should check expiry with a small buffer, not the 24h default', async () => {
        vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(false);

        authCtr.afterAppReady();
        await vi.advanceTimersByTimeAsync(100);

        const [buffer] = vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mock.calls[0];
        expect(buffer).toBeGreaterThan(0);
        expect(buffer).toBeLessThanOrEqual(60 * 60 * 1000);
      });

      it('should skip initialization when no access token exists', async () => {
        vi.mocked(mockRemoteServerConfigCtr.getAccessToken).mockResolvedValue(null);
        vi.mocked(mockRemoteServerConfigCtr.isTokenExpiringSoon).mockReturnValue(true);

        authCtr.afterAppReady();
        await vi.advanceTimersByTimeAsync(100);

        expect(mockRemoteServerConfigCtr.refreshAccessToken).not.toHaveBeenCalled();
      });
    });
  });
});
