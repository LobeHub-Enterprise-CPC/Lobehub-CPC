import type { CloudTenant, DataSyncConfig } from '@lobechat/electron-client-ipc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { App } from '@/core/App';

import RemoteServerConfigCtr from '../RemoteServerConfigCtr';

const { ipcMainHandleMock, mockFetch } = vi.hoisted(() => ({
  ipcMainHandleMock: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock('@/utils/net-fetch', () => ({
  netFetch: mockFetch,
}));

// Mock electron
vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.2.3'),
  },
  ipcMain: {
    handle: ipcMainHandleMock,
  },
  safeStorage: {
    decryptString: vi.fn((buffer: Buffer) => buffer.toString()),
    encryptString: vi.fn((str: string) => Buffer.from(str)),
    isEncryptionAvailable: vi.fn(() => true),
  },
}));

// Mock @/const/env
vi.mock('@/const/env', () => ({
  isDev: false,
  OFFICIAL_CLOUD_SERVER: 'https://cloud.lobehub.com',
}));

// Mock storeManager
const mockStoreManager = {
  delete: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  setMany: vi.fn(),
};

const mockBrowserManager = {
  broadcastToAllWindows: vi.fn(),
};

const mockGatewayConnectionSrv = {
  disconnect: vi.fn().mockResolvedValue({ success: true }),
};

const mockApp = {
  browserManager: mockBrowserManager,
  getController: vi.fn(),
  getService: vi.fn().mockReturnValue(mockGatewayConnectionSrv),
  storeManager: mockStoreManager,
} as unknown as App;

const ENTRY = 'https://platform.example/t/acme';

const cloudTenant = (overrides: Record<string, unknown> = {}) => ({
  display: { account: 'alice@example.com', organizationName: 'Acme' },
  entryUrl: ENTRY,
  generation: 'gen-1',
  identity: { issuer: `${ENTRY}/oidc`, subject: 'user-1', tenantId: 'tenant-1' },
  ...overrides,
});

/** A key-aware store so persisted config and tokens can be inspected independently. */
const useStore = (initial: Record<string, unknown>) => {
  const data: Record<string, unknown> = { ...initial };
  mockStoreManager.get.mockImplementation((key: string) => data[key]);
  mockStoreManager.set.mockImplementation((key: string, value: unknown) => {
    data[key] = value;
  });
  mockStoreManager.setMany.mockImplementation((entries: Record<string, unknown>) => {
    Object.assign(data, entries);
  });
  mockStoreManager.delete.mockImplementation((key: string) => {
    delete data[key];
  });
  return data;
};

describe('RemoteServerConfigCtr', () => {
  let controller: RemoteServerConfigCtr;

  beforeEach(() => {
    vi.clearAllMocks();
    ipcMainHandleMock.mockClear();
    mockStoreManager.get.mockReturnValue({
      active: false,
      storageMode: 'cloud',
    });
    controller = new RemoteServerConfigCtr(mockApp);
  });

  describe('getRemoteServerConfig', () => {
    it('should return stored configuration', async () => {
      const config: DataSyncConfig = {
        active: true,
        remoteServerUrl: 'https://my-server.com',
        storageMode: 'selfHost',
      };
      mockStoreManager.get.mockReturnValue(config);

      const result = await controller.getRemoteServerConfig();

      expect(result).toEqual(config);
      expect(mockStoreManager.get).toHaveBeenCalledWith('dataSyncConfig');
    });
  });

  describe('setRemoteServerConfig', () => {
    it('should update configuration', async () => {
      const prevConfig: DataSyncConfig = {
        active: false,
        storageMode: 'cloud',
      };
      mockStoreManager.get.mockReturnValue(prevConfig);

      const newConfig: Partial<DataSyncConfig> = {
        active: true,
        remoteServerUrl: 'https://my-server.com',
        storageMode: 'selfHost',
      };

      const result = await controller.setRemoteServerConfig(newConfig);

      expect(result).toBe(true);
      expect(mockStoreManager.set).toHaveBeenCalledWith('dataSyncConfig', {
        ...prevConfig,
        ...newConfig,
      });
    });

    it('closes the device gateway connection when switching to another server', async () => {
      mockStoreManager.get.mockReturnValue({
        active: true,
        remoteServerUrl: 'https://a.example.com',
        storageMode: 'selfHost',
      });

      await controller.setRemoteServerConfig({
        active: false,
        remoteServerUrl: 'https://b.example.com',
        storageMode: 'selfHost',
      });

      expect(mockGatewayConnectionSrv.disconnect).toHaveBeenCalledTimes(1);
    });

    it('closes the device gateway connection when the login is deactivated', async () => {
      mockStoreManager.get.mockReturnValue({ active: true, storageMode: 'cloud' });

      await controller.setRemoteServerConfig({ active: false });

      expect(mockGatewayConnectionSrv.disconnect).toHaveBeenCalledTimes(1);
    });

    it('keeps the connection when re-activating the same server after sign-in', async () => {
      mockStoreManager.get.mockReturnValue({
        active: false,
        remoteServerUrl: 'https://a.example.com',
        storageMode: 'selfHost',
      });

      await controller.setRemoteServerConfig({ active: true });

      expect(mockGatewayConnectionSrv.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('legacy local configuration', () => {
    let storedConfig: unknown;

    beforeEach(() => {
      storedConfig = { active: false, storageMode: 'local' };
      mockStoreManager.get.mockImplementation((key: string) =>
        key === 'dataSyncConfig' ? structuredClone(storedConfig) : undefined,
      );
      mockStoreManager.set.mockImplementation((key: string, value: unknown) => {
        if (key === 'dataSyncConfig') storedConfig = structuredClone(value);
      });
    });

    afterEach(() => {
      mockStoreManager.get.mockReset();
      mockStoreManager.set.mockReset();
    });

    it('reads legacy configuration as cloud without changing the stored configuration', async () => {
      expect(await controller.getRemoteServerConfig()).toEqual({
        active: false,
        remoteServerUrl: 'https://cloud.lobehub.com',
        storageMode: 'cloud',
      });
      expect(storedConfig).toEqual({ active: false, storageMode: 'local' });
      expect(mockStoreManager.set).not.toHaveBeenCalled();
    });

    it.each([true, false])(
      'never falls back to the upstream cloud URL and writes nothing (explicit config: %s)',
      async (explicitConfig) => {
        const config = mockStoreManager.get('dataSyncConfig');
        // A private deployment only connects to a confirmed tenant entry.
        expect(
          await controller.getRemoteServerUrl(explicitConfig ? config : undefined),
        ).toBeUndefined();
        expect(storedConfig).toEqual({ active: false, storageMode: 'local' });
        expect(mockStoreManager.set).not.toHaveBeenCalled();
      },
    );

    it('keeps activation persisted when comparing the previous server URL', async () => {
      expect(await controller.setRemoteServerConfig({ active: true })).toBe(true);

      expect(storedConfig).toEqual({
        active: true,
        remoteServerUrl: 'https://cloud.lobehub.com',
        storageMode: 'cloud',
      });
      expect(mockStoreManager.set).toHaveBeenCalledTimes(1);
      expect(mockGatewayConnectionSrv.disconnect).not.toHaveBeenCalled();
    });

    it('keeps the new self-hosted server persisted and disconnects the previous gateway', async () => {
      expect(
        await controller.setRemoteServerConfig({
          active: true,
          remoteServerUrl: 'https://new.example.com',
          storageMode: 'selfHost',
        }),
      ).toBe(true);

      expect(storedConfig).toEqual({
        active: true,
        remoteServerUrl: 'https://new.example.com',
        storageMode: 'selfHost',
      });
      expect(mockStoreManager.set).toHaveBeenCalledTimes(1);
      expect(mockGatewayConnectionSrv.disconnect).toHaveBeenCalledTimes(1);
    });

    it('keeps deactivation persisted and disconnects the previous gateway', async () => {
      storedConfig = { active: true, storageMode: 'local' };
      expect(await controller.setRemoteServerConfig({ active: false })).toBe(true);

      expect(storedConfig).toEqual({
        active: false,
        remoteServerUrl: 'https://cloud.lobehub.com',
        storageMode: 'cloud',
      });
      expect(mockStoreManager.set).toHaveBeenCalledTimes(1);
      expect(mockGatewayConnectionSrv.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('remote server URL with a tenant path prefix', () => {
    it('keeps the path prefix and drops trailing slashes when saving', async () => {
      mockStoreManager.get.mockReturnValue({ active: false, storageMode: 'cloud' });

      await controller.setRemoteServerConfig({
        active: true,
        remoteServerUrl: '  https://host.example/t/acme/  ',
        storageMode: 'selfHost',
      });

      expect(mockStoreManager.set).toHaveBeenCalledWith(
        'dataSyncConfig',
        expect.objectContaining({ remoteServerUrl: 'https://host.example/t/acme' }),
      );
    });

    it('normalizes previously stored addresses on read', async () => {
      mockStoreManager.get.mockReturnValue({
        active: true,
        remoteServerUrl: 'https://host.example/t/acme/',
        storageMode: 'selfHost',
      });

      expect(await controller.getRemoteServerUrl()).toBe('https://host.example/t/acme');
      expect((await controller.getRemoteServerConfig()).remoteServerUrl).toBe(
        'https://host.example/t/acme',
      );
    });

    it('accepts a tenant address as a valid self-host URL', async () => {
      expect(
        await controller.isRemoteServerConfigured({
          active: true,
          remoteServerUrl: 'https://host.example/t/acme',
          storageMode: 'selfHost',
        }),
      ).toBe(true);
    });
  });

  describe('clearRemoteServerConfig', () => {
    it('should clear configuration and tokens', async () => {
      const result = await controller.clearRemoteServerConfig();

      expect(result).toBe(true);
      expect(mockStoreManager.set).toHaveBeenCalledWith('dataSyncConfig', {
        active: false,
        storageMode: 'cloud',
      });
      expect(mockStoreManager.delete).toHaveBeenCalledWith('encryptedTokens');
    });
  });

  describe('saveTokens', () => {
    it('should save encrypted tokens with expiration', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);

      await controller.saveTokens('access-token', 'refresh-token', 3600);

      expect(safeStorage.encryptString).toHaveBeenCalledWith('access-token');
      expect(safeStorage.encryptString).toHaveBeenCalledWith('refresh-token');
      expect(mockStoreManager.set).toHaveBeenCalledWith(
        'encryptedTokens',
        expect.objectContaining({
          accessToken: expect.any(String),
          expiresAt: expect.any(Number),
          refreshToken: expect.any(String),
        }),
      );
    });

    it('should save tokens without expiration', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);

      await controller.saveTokens('access-token', 'refresh-token');

      expect(mockStoreManager.set).toHaveBeenCalledWith(
        'encryptedTokens',
        expect.objectContaining({
          accessToken: expect.any(String),
          expiresAt: undefined,
          refreshToken: expect.any(String),
        }),
      );
    });

    it('should save unencrypted tokens when encryption is not available', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);

      await controller.saveTokens('access-token', 'refresh-token', 3600);

      expect(safeStorage.encryptString).not.toHaveBeenCalled();
      expect(mockStoreManager.set).toHaveBeenCalledWith(
        'encryptedTokens',
        expect.objectContaining({
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        }),
      );
    });
  });

  describe('getDesktopBootstrapIdentity', () => {
    const createAccessToken = (sub: string, tid?: string) =>
      [
        'header',
        Buffer.from(JSON.stringify({ sub, ...(tid ? { tid } : {}) })).toString('base64url'),
        'signature',
      ].join('.');

    it('returns the tenant of the committed token so the renderer can partition local state', async () => {
      await controller.saveTokens(createAccessToken('user-bootstrap', 'tenant-a'), 'refresh-token');

      expect(controller.getDesktopBootstrapIdentity()).toEqual({
        isIdentityResolved: true,
        tenantId: 'tenant-a',
        userId: 'user-bootstrap',
      });
    });

    it('returns the OIDC subject without requesting full user state', async () => {
      await controller.saveTokens(createAccessToken('user-bootstrap'), 'refresh-token');

      expect(controller.getDesktopBootstrapIdentity()).toEqual({
        isIdentityResolved: true,
        userId: 'user-bootstrap',
      });
    });

    it('resolves to signed-out when no encrypted token exists', () => {
      expect(controller.getDesktopBootstrapIdentity()).toEqual({ isIdentityResolved: true });
    });

    it('keeps the cache scope untrusted when the stored token cannot identify a subject', async () => {
      await controller.saveTokens('not-a-jwt', 'refresh-token');

      expect(controller.getDesktopBootstrapIdentity()).toEqual({ isIdentityResolved: false });
    });
  });

  describe('getRemoteCredentials', () => {
    const login = (entryUrl: string, accessToken: string, generation: string) => ({
      display: { account: 'alice@example.com' },
      entryUrl,
      generation,
      identity: { issuer: `${entryUrl}/oidc`, subject: 'user-1', tenantId: `tenant-${generation}` },
      storageMode: 'cloud' as const,
      tokens: { accessToken, refreshToken: `refresh-${generation}` },
    });

    it('returns the committed entry together with its own token', async () => {
      useStore({ dataSyncConfig: { active: false, storageMode: 'cloud' } });
      await controller.commitAuthorization(login(ENTRY, 'access-a', 'a'));

      await expect(controller.getRemoteCredentials()).resolves.toEqual({
        serverUrl: ENTRY,
        token: 'access-a',
      });
    });

    it('has no credentials when signed out', async () => {
      useStore({ dataSyncConfig: { active: false, storageMode: 'cloud' } });

      await expect(controller.getRemoteCredentials()).resolves.toBeNull();
    });

    it('has no credentials while remote activity is paused for a changed endpoint', async () => {
      useStore({ dataSyncConfig: { active: false, storageMode: 'cloud' } });
      await controller.commitAuthorization(login(ENTRY, 'access-a', 'a'));
      controller.handleEndpointChanged();

      await expect(controller.getRemoteCredentials()).resolves.toBeNull();
    });

    it('never pairs the old entry with the token of a login committed between the reads', async () => {
      useStore({ dataSyncConfig: { active: false, storageMode: 'cloud' } });
      await controller.commitAuthorization(login(ENTRY, 'access-a', 'a'));
      const original = controller.getAccessToken.bind(controller);
      vi.spyOn(controller, 'getAccessToken').mockImplementation(async () => {
        const token = await original();
        await controller.commitAuthorization(
          login('https://platform.example/t/other', 'access-b', 'b'),
        );
        return token;
      });

      await expect(controller.getRemoteCredentials()).resolves.toBeNull();
    });
  });

  describe('getAccessToken', () => {
    it('should return decrypted access token', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);

      // First save a token
      await controller.saveTokens('test-access-token', 'test-refresh-token');

      const result = await controller.getAccessToken();

      expect(result).toBe('test-access-token');
    });

    it('should load token from store if not in memory', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
      vi.mocked(safeStorage.decryptString).mockReturnValue('stored-access-token');

      mockStoreManager.get.mockImplementation((key) => {
        if (key === 'encryptedTokens') {
          return {
            accessToken: Buffer.from('stored-access-token').toString('base64'),
            refreshToken: Buffer.from('stored-refresh-token').toString('base64'),
          };
        }
        return { active: false, storageMode: 'cloud' };
      });

      // Create new controller to test loading from store
      const newController = new RemoteServerConfigCtr(mockApp);
      const result = await newController.getAccessToken();

      expect(result).toBe('stored-access-token');
    });

    it('should return null when no token exists', async () => {
      mockStoreManager.get.mockImplementation((key) => {
        if (key === 'encryptedTokens') {
          return null;
        }
        return { active: false, storageMode: 'cloud' };
      });

      const newController = new RemoteServerConfigCtr(mockApp);
      const result = await newController.getAccessToken();

      expect(result).toBeNull();
    });

    it('should return raw token when encryption is not available', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);

      await controller.saveTokens('raw-access-token', 'raw-refresh-token');
      const result = await controller.getAccessToken();

      expect(result).toBe('raw-access-token');
    });

    it('should return null on decryption error', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
      vi.mocked(safeStorage.decryptString).mockImplementation(() => {
        throw new Error('Decryption failed');
      });

      mockStoreManager.get.mockImplementation((key) => {
        if (key === 'encryptedTokens') {
          return {
            accessToken: 'invalid-encrypted-token',
            refreshToken: 'invalid-encrypted-token',
          };
        }
        return { active: false, storageMode: 'cloud' };
      });

      const newController = new RemoteServerConfigCtr(mockApp);
      const result = await newController.getAccessToken();

      expect(result).toBeNull();
    });
  });

  describe('getRefreshToken', () => {
    it('should return decrypted refresh token', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
      vi.mocked(safeStorage.decryptString).mockImplementation((buffer: Buffer) =>
        buffer.toString(),
      );

      await controller.saveTokens('test-access-token', 'test-refresh-token');

      const result = await controller.getRefreshToken();

      expect(result).toBe('test-refresh-token');
    });

    it('should return null when no token exists', async () => {
      mockStoreManager.get.mockImplementation((key) => {
        if (key === 'encryptedTokens') {
          return null;
        }
        return { active: false, storageMode: 'cloud' };
      });

      const newController = new RemoteServerConfigCtr(mockApp);
      const result = await newController.getRefreshToken();

      expect(result).toBeNull();
    });
  });

  describe('clearTokens', () => {
    it('should clear all tokens from memory and store', async () => {
      await controller.saveTokens('access', 'refresh', 3600);
      await controller.clearTokens();

      expect(mockStoreManager.delete).toHaveBeenCalledWith('encryptedTokens');

      // Verify tokens are cleared from memory
      const accessToken = await controller.getAccessToken();
      expect(accessToken).toBeNull();
    });

    it('should disconnect gateway when tokens are cleared', async () => {
      await controller.saveTokens('access', 'refresh', 3600);
      await controller.clearTokens();

      expect(mockGatewayConnectionSrv.disconnect).toHaveBeenCalled();
    });
  });

  describe('getTokenExpiresAt', () => {
    it('should return expiration time after saving tokens with expiration', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);

      const beforeSave = Date.now();
      await controller.saveTokens('access', 'refresh', 3600);
      const afterSave = Date.now();

      const expiresAt = controller.getTokenExpiresAt();

      expect(expiresAt).toBeDefined();
      expect(expiresAt).toBeGreaterThanOrEqual(beforeSave + 3600 * 1000);
      expect(expiresAt).toBeLessThanOrEqual(afterSave + 3600 * 1000);
    });

    it('should return undefined when no expiration is set', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);

      await controller.saveTokens('access', 'refresh');

      const expiresAt = controller.getTokenExpiresAt();

      expect(expiresAt).toBeUndefined();
    });
  });

  describe('isTokenExpiringSoon', () => {
    it('should return false when no expiration is set', () => {
      const result = controller.isTokenExpiringSoon();

      expect(result).toBe(false);
    });

    it('should return false when token is not expiring soon', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);

      // Token expires in 2 days (well beyond the 24-hour default buffer)
      await controller.saveTokens('access', 'refresh', 2 * 24 * 3600);

      // Default buffer is 24 hours
      const result = controller.isTokenExpiringSoon();

      expect(result).toBe(false);
    });

    it('should return true when token is within buffer time', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);

      // Token expires in 2 minutes
      await controller.saveTokens('access', 'refresh', 120);

      // Default buffer is 5 minutes, so token is expiring soon
      const result = controller.isTokenExpiringSoon();

      expect(result).toBe(true);
    });

    it('should respect custom buffer time', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);

      // Token expires in 10 minutes
      await controller.saveTokens('access', 'refresh', 600);

      // With 15 minute buffer, should be expiring soon
      const result = controller.isTokenExpiringSoon(15 * 60 * 1000);

      expect(result).toBe(true);
    });
  });

  describe('isNonRetryableError', () => {
    it('should return false for null/undefined error', () => {
      expect(controller.isNonRetryableError(undefined)).toBe(false);
      expect(controller.isNonRetryableError('')).toBe(false);
    });

    it('should return true for OIDC error codes', () => {
      expect(controller.isNonRetryableError('invalid_grant')).toBe(true);
      expect(controller.isNonRetryableError('Token refresh failed: invalid_client')).toBe(true);
      expect(controller.isNonRetryableError('unauthorized_client error')).toBe(true);
      expect(controller.isNonRetryableError('access_denied by user')).toBe(true);
      expect(controller.isNonRetryableError('invalid_scope requested')).toBe(true);
    });

    it('should return true for deterministic failures', () => {
      expect(controller.isNonRetryableError('No refresh token available')).toBe(true);
      expect(controller.isNonRetryableError('Remote server is not active or configured')).toBe(
        true,
      );
      expect(controller.isNonRetryableError('Missing tokens in refresh response')).toBe(true);
    });

    it('should return false for transient/network errors', () => {
      expect(controller.isNonRetryableError('Network error')).toBe(false);
      expect(controller.isNonRetryableError('fetch failed')).toBe(false);
      expect(controller.isNonRetryableError('ETIMEDOUT')).toBe(false);
      expect(controller.isNonRetryableError('Connection refused')).toBe(false);
    });

    it('should be case insensitive', () => {
      expect(controller.isNonRetryableError('INVALID_GRANT')).toBe(true);
      expect(controller.isNonRetryableError('NO REFRESH TOKEN AVAILABLE')).toBe(true);
    });
  });

  describe('refreshAccessToken', () => {
    it('should return error when remote server is not active', async () => {
      mockStoreManager.get.mockImplementation((key) => {
        if (key === 'dataSyncConfig') {
          return { active: false, storageMode: 'cloud' };
        }
        return null;
      });

      const result = await controller.refreshAccessToken();

      expect(result.success).toBe(false);
      expect(result.error).toContain('not active');
    });

    it('should return error when no refresh token available', async () => {
      mockStoreManager.get.mockImplementation((key) => {
        if (key === 'dataSyncConfig') {
          return {
            active: true,
            remoteServerUrl: 'https://server.com',
            storageMode: 'selfHost',
          };
        }
        if (key === 'encryptedTokens') {
          return null;
        }
        return null;
      });

      const newController = new RemoteServerConfigCtr(mockApp);
      const result = await newController.refreshAccessToken();

      expect(result.success).toBe(false);
      expect(result.error).toContain('No refresh token');
    });

    it('should refresh token successfully', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
      vi.mocked(safeStorage.decryptString).mockImplementation((buffer: Buffer) =>
        buffer.toString(),
      );

      mockStoreManager.get.mockImplementation((key) => {
        if (key === 'dataSyncConfig') {
          return {
            active: true,
            remoteServerUrl: 'https://server.com',
            storageMode: 'selfHost',
          };
        }
        return null;
      });

      // Save initial tokens
      await controller.saveTokens('old-access', 'old-refresh');

      mockFetch.mockResolvedValue({
        json: () =>
          Promise.resolve({
            access_token: 'new-access-token',
            expires_in: 3600,
            refresh_token: 'new-refresh-token',
          }),
        ok: true,
      });

      const result = await controller.refreshAccessToken();

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://server.com/oidc/token',
        expect.objectContaining({
          body: expect.stringContaining('grant_type=refresh_token'),
          headers: expect.objectContaining({
            'User-Agent': 'LobeHub Desktop/1.2.3',
          }),
          method: 'POST',
        }),
      );
    });

    it.each(['https://server.com/t/acme', 'https://server.com/t/acme/'])(
      'should refresh the token under the tenant path prefix of %s',
      async (remoteServerUrl) => {
        const { safeStorage } = await import('electron');
        vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
        vi.mocked(safeStorage.decryptString).mockImplementation((buffer: Buffer) =>
          buffer.toString(),
        );

        mockStoreManager.get.mockImplementation((key) => {
          if (key === 'dataSyncConfig') {
            return { active: true, remoteServerUrl, storageMode: 'selfHost' };
          }
          return null;
        });

        await controller.saveTokens('old-access', 'old-refresh');

        mockFetch.mockResolvedValue({
          json: () =>
            Promise.resolve({
              access_token: 'new-access-token',
              expires_in: 3600,
              refresh_token: 'new-refresh-token',
            }),
          ok: true,
        });

        const result = await controller.refreshAccessToken();

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0]).toBe('https://server.com/t/acme/oidc/token');
      },
    );

    it.each([
      { error: 'invalid_grant' },
      { error: 'invalid_grant', error_description: 'grant request is invalid' },
      { error: 'invalid_client', error_description: 'client authentication failed' },
    ])('should classify refresh failure as non-retryable: %j', async (errorData) => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
      vi.mocked(safeStorage.decryptString).mockImplementation((buffer: Buffer) =>
        buffer.toString(),
      );

      mockStoreManager.get.mockImplementation((key) => {
        if (key === 'dataSyncConfig') {
          return {
            active: true,
            remoteServerUrl: 'https://server.com',
            storageMode: 'selfHost',
          };
        }
        return null;
      });

      await controller.saveTokens('old-access', 'old-refresh');

      mockFetch.mockResolvedValue({
        json: () => Promise.resolve(errorData),
        ok: false,
        status: 400,
        statusText: 'Bad Request',
      });

      const result = await controller.refreshAccessToken();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Token refresh failed');
      expect(result.error).toContain(errorData.error);
      if (errorData.error_description) {
        expect(result.error).toContain(errorData.error_description);
      }
      expect(controller.isNonRetryableError(result.error)).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle missing tokens in response', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
      vi.mocked(safeStorage.decryptString).mockImplementation((buffer: Buffer) =>
        buffer.toString(),
      );

      mockStoreManager.get.mockImplementation((key) => {
        if (key === 'dataSyncConfig') {
          return {
            active: true,
            remoteServerUrl: 'https://server.com',
            storageMode: 'selfHost',
          };
        }
        return null;
      });

      await controller.saveTokens('old-access', 'old-refresh');

      mockFetch.mockResolvedValue({
        json: () => Promise.resolve({}), // Missing tokens
        ok: true,
      });

      const result = await controller.refreshAccessToken();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing tokens');
    });

    it('should handle concurrent refresh requests by returning same result', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
      vi.mocked(safeStorage.decryptString).mockImplementation((buffer: Buffer) =>
        buffer.toString(),
      );

      mockStoreManager.get.mockImplementation((key) => {
        if (key === 'dataSyncConfig') {
          return {
            active: true,
            remoteServerUrl: 'https://server.com',
            storageMode: 'selfHost',
          };
        }
        return null;
      });

      await controller.saveTokens('old-access', 'old-refresh');

      let resolvePromise: (value: any) => void;
      const delayedResponse = new Promise((resolve) => {
        resolvePromise = resolve;
      });

      mockFetch.mockReturnValue(delayedResponse);

      // Start two concurrent refresh requests
      const promise1 = controller.refreshAccessToken();
      const promise2 = controller.refreshAccessToken();

      // Resolve the fetch
      resolvePromise!({
        json: () =>
          Promise.resolve({
            access_token: 'new-access',
            expires_in: 3600,
            refresh_token: 'new-refresh',
          }),
        ok: true,
      });

      const [result1, result2] = await Promise.all([promise1, promise2]);

      // Both results should be equal (same success)
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should not retry after a network error', async () => {
      const { safeStorage } = await import('electron');
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
      vi.mocked(safeStorage.decryptString).mockImplementation((buffer: Buffer) =>
        buffer.toString(),
      );

      mockStoreManager.get.mockImplementation((key) => {
        if (key === 'dataSyncConfig') {
          return {
            active: true,
            remoteServerUrl: 'https://server.com',
            storageMode: 'selfHost',
          };
        }
        return null;
      });

      await controller.saveTokens('old-access', 'old-refresh');

      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await controller.refreshAccessToken();

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
      expect(controller.isNonRetryableError(result.error)).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('afterAppReady', () => {
    it('should load tokens from store', () => {
      mockStoreManager.get.mockImplementation((key) => {
        if (key === 'encryptedTokens') {
          return {
            accessToken: 'stored-access',
            expiresAt: Date.now() + 3600000,
            refreshToken: 'stored-refresh',
          };
        }
        return { active: false, storageMode: 'cloud' };
      });

      const newController = new RemoteServerConfigCtr(mockApp);
      newController.afterAppReady();

      // Verify tokens were loaded by checking getTokenExpiresAt
      expect(newController.getTokenExpiresAt()).toBeDefined();
    });

    it('should load lastRefreshAt from store', () => {
      const lastRefreshTime = Date.now() - 3600000; // 1 hour ago
      mockStoreManager.get.mockImplementation((key) => {
        if (key === 'encryptedTokens') {
          return {
            accessToken: 'stored-access',
            expiresAt: Date.now() + 3600000,
            lastRefreshAt: lastRefreshTime,
            refreshToken: 'stored-refresh',
          };
        }
        return { active: false, storageMode: 'cloud' };
      });

      const newController = new RemoteServerConfigCtr(mockApp);
      newController.afterAppReady();

      // Verify lastRefreshAt was loaded
      expect(newController.getLastTokenRefreshAt()).toBe(lastRefreshTime);
    });
  });

  describe('getLastTokenRefreshAt', () => {
    it('should return undefined when no tokens have been saved', () => {
      expect(controller.getLastTokenRefreshAt()).toBeUndefined();
    });

    it('should return the last refresh time after saving tokens', async () => {
      const beforeSave = Date.now();
      await controller.saveTokens('access', 'refresh', 3600);
      const afterSave = Date.now();

      const lastRefreshAt = controller.getLastTokenRefreshAt();

      expect(lastRefreshAt).toBeDefined();
      expect(lastRefreshAt).toBeGreaterThanOrEqual(beforeSave);
      expect(lastRefreshAt).toBeLessThanOrEqual(afterSave);
    });

    it('should persist lastRefreshAt to store when saving tokens', async () => {
      await controller.saveTokens('access', 'refresh', 3600);

      expect(mockStoreManager.set).toHaveBeenCalledWith(
        'encryptedTokens',
        expect.objectContaining({
          lastRefreshAt: expect.any(Number),
        }),
      );
    });
  });

  describe('getRemoteServerUrl', () => {
    it('should have no server for a cloud config without a confirmed tenant (no platform fallback)', async () => {
      mockStoreManager.get.mockReturnValue({
        active: true,
        storageMode: 'cloud',
      });

      const result = await controller.getRemoteServerUrl();

      expect(result).toBeUndefined();
    });

    it('should return the confirmed tenant entry for cloud mode', async () => {
      mockStoreManager.get.mockReturnValue({
        active: true,
        cloudTenant: cloudTenant(),
        storageMode: 'cloud',
      });

      expect(await controller.getRemoteServerUrl()).toBe(ENTRY);
    });

    it('should return custom URL for selfHost mode', async () => {
      mockStoreManager.get.mockReturnValue({
        active: true,
        remoteServerUrl: 'https://my-server.com',
        storageMode: 'selfHost',
      });

      const result = await controller.getRemoteServerUrl();

      expect(result).toBe('https://my-server.com');
    });

    it('should use provided config instead of stored config', async () => {
      const customConfig: DataSyncConfig = {
        active: true,
        remoteServerUrl: 'https://custom-server.com',
        storageMode: 'selfHost',
      };

      const result = await controller.getRemoteServerUrl(customConfig);

      expect(result).toBe('https://custom-server.com');
    });
  });

  describe('isRemoteServerConfigured', () => {
    it('should return false when active is undefined', async () => {
      mockStoreManager.get.mockReturnValue({
        storageMode: 'cloud',
      });

      const result = await controller.isRemoteServerConfigured();

      expect(result).toBe(false);
    });

    it('should return true for active cloud mode with a confirmed tenant', async () => {
      mockStoreManager.get.mockReturnValue({
        active: true,
        cloudTenant: cloudTenant(),
        storageMode: 'cloud',
      });

      const result = await controller.isRemoteServerConfigured();

      expect(result).toBe(true);
    });

    it('should return false for active cloud mode without a confirmed tenant', async () => {
      mockStoreManager.get.mockReturnValue({ active: true, storageMode: 'cloud' });

      expect(await controller.isRemoteServerConfigured()).toBe(false);
    });

    it('should return true for active selfHost mode with remoteServerUrl', async () => {
      mockStoreManager.get.mockReturnValue({
        active: true,
        remoteServerUrl: 'https://my-server.com',
        storageMode: 'selfHost',
      });

      const result = await controller.isRemoteServerConfigured();

      expect(result).toBe(true);
    });

    it('should return false for inactive config', async () => {
      mockStoreManager.get.mockReturnValue({
        active: false,
        storageMode: 'cloud',
      });

      const result = await controller.isRemoteServerConfigured();

      expect(result).toBe(false);
    });

    it('should return false for selfHost mode without remoteServerUrl', async () => {
      mockStoreManager.get.mockReturnValue({
        active: true,
        storageMode: 'selfHost',
        // remoteServerUrl is undefined
      });

      const result = await controller.isRemoteServerConfigured();

      expect(result).toBe(false);
    });

    it('should return false for selfHost mode with blank remoteServerUrl', async () => {
      mockStoreManager.get.mockReturnValue({
        active: true,
        remoteServerUrl: '   ',
        storageMode: 'selfHost',
      });

      const result = await controller.isRemoteServerConfigured();

      expect(result).toBe(false);
    });

    it('should return false for selfHost mode with invalid remoteServerUrl', async () => {
      mockStoreManager.get.mockReturnValue({
        active: true,
        remoteServerUrl: 'foo',
        storageMode: 'selfHost',
      });

      const result = await controller.isRemoteServerConfigured();

      expect(result).toBe(false);
    });

    it('should use provided config instead of fetching', async () => {
      // Store has inactive config
      mockStoreManager.get.mockReturnValue({
        active: false,
        storageMode: 'cloud',
      });

      // But we provide an active config
      const result = await controller.isRemoteServerConfigured({
        active: true,
        cloudTenant: cloudTenant(),
        storageMode: 'cloud',
      });

      expect(result).toBe(true);
    });
  });

  describe('confirmed tenant state', () => {
    const tokens = (generation?: string) => ({
      accessToken: 'enc-access',
      generation,
      refreshToken: 'enc-refresh',
    });

    beforeEach(() => {
      mockStoreManager.get.mockReset();
      mockStoreManager.set.mockReset();
      mockStoreManager.setMany.mockReset();
      mockStoreManager.delete.mockReset();
    });

    describe('commitAuthorization', () => {
      it('writes tokens, tenant record and active in one atomic store write with one generation', async () => {
        const data = useStore({ dataSyncConfig: { active: false, storageMode: 'cloud' } });

        await controller.commitAuthorization({
          display: { account: 'alice@example.com', organizationName: 'Acme' },
          entryUrl: ENTRY,
          generation: 'gen-2',
          identity: { issuer: `${ENTRY}/oidc`, subject: 'user-1', tenantId: 'tenant-1' },
          storageMode: 'cloud',
          tokens: { accessToken: 'access', expiresIn: 3600, refreshToken: 'refresh' },
        });

        expect(mockStoreManager.setMany).toHaveBeenCalledTimes(1);
        expect(mockStoreManager.set).not.toHaveBeenCalled();
        expect(data.dataSyncConfig).toMatchObject({
          active: true,
          cloudTenant: { entryUrl: ENTRY, generation: 'gen-2' },
          storageMode: 'cloud',
        });
        expect((data.encryptedTokens as { generation: string }).generation).toBe('gen-2');
        expect(await controller.getAccessToken()).toBe('access');
        expect(mockBrowserManager.broadcastToAllWindows).toHaveBeenCalledWith(
          'remoteServerConfigUpdated',
          undefined,
        );
      });

      it('never touches the gateway token: the caller reconnects after the commit', async () => {
        useStore({ dataSyncConfig: { active: false, storageMode: 'cloud' } });

        await controller.commitAuthorization({
          display: { account: 'a' },
          entryUrl: ENTRY,
          generation: 'gen-2',
          identity: { issuer: `${ENTRY}/oidc`, subject: 's', tenantId: 't' },
          storageMode: 'cloud',
          tokens: { accessToken: 'access', refreshToken: 'refresh' },
        });

        expect(mockGatewayConnectionSrv.disconnect).not.toHaveBeenCalled();
      });

      it('keeps the typed address of a self-hosted config and does not leak one into cloud mode', async () => {
        const data = useStore({
          dataSyncConfig: {
            active: false,
            remoteServerUrl: 'https://old.example',
            storageMode: 'selfHost',
          },
        });
        const base = {
          display: { account: 'a' },
          entryUrl: ENTRY,
          generation: 'gen-2',
          identity: { issuer: `${ENTRY}/oidc`, subject: 's', tenantId: 't' },
          tokens: { accessToken: 'access', refreshToken: 'refresh' },
        };

        await controller.commitAuthorization({
          ...base,
          remoteServerUrl: ENTRY,
          storageMode: 'selfHost',
        });
        expect(data.dataSyncConfig).toMatchObject({
          remoteServerUrl: ENTRY,
          storageMode: 'selfHost',
        });

        await controller.commitAuthorization({ ...base, storageMode: 'cloud' });
        expect(data.dataSyncConfig).not.toHaveProperty('remoteServerUrl');
      });
    });

    describe('commitAuthorization keeps the matching historical organization name', () => {
      const previous = {
        display: { account: 'alice@example.com', organizationName: 'Acme Inc' },
        entryUrl: ENTRY,
        generation: 'gen-1',
        identity: { issuer: `${ENTRY}/oidc`, subject: 'user-1', tenantId: 'tenant-1' },
      };
      const relogin = (overrides: Record<string, unknown> = {}) => ({
        display: { account: 'alice@example.com' } as { account: string; organizationName?: string },
        entryUrl: ENTRY,
        generation: 'gen-2',
        identity: { ...previous.identity },
        storageMode: 'cloud' as const,
        tokens: { accessToken: 'access', refreshToken: 'refresh' },
        ...overrides,
      });
      const committedTenant = (data: Record<string, unknown>) =>
        (data.dataSyncConfig as { cloudTenant: { display: Record<string, unknown> } }).cloudTenant;

      it('does not overwrite it with empty on a same-identity re-login without a name', async () => {
        // Session expired earlier: tokens gone, the last confirmed record is still stored.
        const data = useStore({
          dataSyncConfig: { active: false, cloudTenant: previous, storageMode: 'cloud' },
        });

        await controller.commitAuthorization(relogin());

        expect(committedTenant(data).display).toEqual({
          account: 'alice@example.com',
          organizationName: 'Acme Inc',
        });
      });

      it('lets a name delivered by this login replace the old one', async () => {
        const data = useStore({
          dataSyncConfig: { active: false, cloudTenant: previous, storageMode: 'cloud' },
        });

        await controller.commitAuthorization(
          relogin({ display: { account: 'alice@example.com', organizationName: 'Acme Renamed' } }),
        );

        expect(committedTenant(data).display.organizationName).toBe('Acme Renamed');
      });

      it.each([
        ['another subject', { identity: { ...previous.identity, subject: 'user-2' } }],
        ['another tenant', { identity: { ...previous.identity, tenantId: 'tenant-2' } }],
        [
          'another issuer',
          { identity: { ...previous.identity, issuer: 'https://x.example/oidc' } },
        ],
        ['another entry', { entryUrl: 'https://platform.example/t/other' }],
      ])('never carries the name over to %s', async (_name, overrides) => {
        const data = useStore({
          dataSyncConfig: { active: false, cloudTenant: previous, storageMode: 'cloud' },
        });

        await controller.commitAuthorization(relogin(overrides));

        expect(committedTenant(data).display).not.toHaveProperty('organizationName');
      });
    });

    describe('commitAuthorization display claims (slug, other organizations)', () => {
      const previous = {
        display: {
          account: 'alice@example.com',
          hasOtherOrganizations: true,
          organizationName: 'Acme Inc',
          organizationSlug: 'acme',
        },
        entryUrl: ENTRY,
        generation: 'gen-1',
        identity: { issuer: `${ENTRY}/oidc`, subject: 'user-1', tenantId: 'tenant-1' },
      };
      const relogin = (
        display: Record<string, unknown> = {},
        overrides: Record<string, unknown> = {},
      ) => ({
        display: { account: 'alice@example.com', ...display } as CloudTenant['display'],
        entryUrl: ENTRY,
        generation: 'gen-2',
        identity: { ...previous.identity },
        storageMode: 'cloud' as const,
        tokens: { accessToken: 'access', refreshToken: 'refresh' },
        ...overrides,
      });
      const committedDisplay = (data: Record<string, unknown>) =>
        (data.dataSyncConfig as { cloudTenant: CloudTenant }).cloudTenant.display;
      const seed = () =>
        useStore({
          dataSyncConfig: { active: false, cloudTenant: previous, storageMode: 'cloud' },
        });

      it('stores the values delivered by this login', async () => {
        const data = useStore({ dataSyncConfig: { active: false, storageMode: 'cloud' } });

        await controller.commitAuthorization(
          relogin({ hasOtherOrganizations: false, organizationSlug: 'acme-2' }),
        );

        expect(committedDisplay(data)).toEqual({
          account: 'alice@example.com',
          hasOtherOrganizations: false,
          organizationSlug: 'acme-2',
        });
      });

      it('lets this login replace the old values, including flipping the flag to false', async () => {
        const data = seed();

        await controller.commitAuthorization(
          relogin({ hasOtherOrganizations: false, organizationSlug: 'acme-renamed' }),
        );

        expect(committedDisplay(data)).toEqual({
          account: 'alice@example.com',
          hasOtherOrganizations: false,
          organizationName: 'Acme Inc',
          organizationSlug: 'acme-renamed',
        });
      });

      it('keeps the committed values on a same-identity re-login that delivers none', async () => {
        const data = seed();

        await controller.commitAuthorization(relogin());

        expect(committedDisplay(data)).toEqual(previous.display);
      });

      it('keeps a committed false flag instead of reverting to unknown', async () => {
        const data = useStore({
          dataSyncConfig: {
            active: false,
            cloudTenant: {
              ...previous,
              display: { ...previous.display, hasOtherOrganizations: false },
            },
            storageMode: 'cloud',
          },
        });

        await controller.commitAuthorization(relogin());

        expect(committedDisplay(data).hasOtherOrganizations).toBe(false);
      });

      it.each([
        ['another subject', { identity: { ...previous.identity, subject: 'user-2' } }],
        ['another tenant', { identity: { ...previous.identity, tenantId: 'tenant-2' } }],
        [
          'another issuer',
          { identity: { ...previous.identity, issuer: 'https://x.example/oidc' } },
        ],
        ['another entry', { entryUrl: 'https://platform.example/t/other' }],
      ])('leaves them unknown for %s that delivers none', async (_name, overrides) => {
        const data = seed();

        await controller.commitAuthorization(relogin({}, overrides));

        const display = committedDisplay(data);
        expect(display).not.toHaveProperty('organizationSlug');
        expect(display).not.toHaveProperty('hasOtherOrganizations');
      });

      it('merges per field: a new slug does not drop the committed flag of the same identity', async () => {
        const data = seed();

        await controller.commitAuthorization(relogin({ organizationSlug: 'acme-3' }));

        expect(committedDisplay(data)).toMatchObject({
          hasOtherOrganizations: true,
          organizationSlug: 'acme-3',
        });
      });

      it('accepts the new fields in a persisted record and rejects wrongly typed ones', async () => {
        useStore({
          dataSyncConfig: { active: true, cloudTenant: previous, storageMode: 'cloud' },
          encryptedTokens: tokens('gen-1'),
        });
        expect(await controller.isRemoteServerConfigured()).toBe(true);

        for (const display of [
          { ...previous.display, organizationSlug: 7 },
          { ...previous.display, hasOtherOrganizations: 'false' },
        ]) {
          useStore({
            dataSyncConfig: {
              active: true,
              cloudTenant: { ...previous, display },
              storageMode: 'cloud',
            },
            encryptedTokens: tokens('gen-1'),
          });
          expect(await controller.isRemoteServerConfigured()).toBe(false);
        }
      });
    });

    describe('startup reconciliation (mismatched or half-committed state means logged out)', () => {
      it('logs out a cloud login that predates the confirmed tenant record', async () => {
        const data = useStore({
          dataSyncConfig: { active: true, storageMode: 'cloud' },
          encryptedTokens: tokens(),
        });

        const config = await controller.getRemoteServerConfig();

        expect(config.active).toBe(false);
        expect(data.encryptedTokens).toBeUndefined();
        expect(await controller.isRemoteServerConfigured()).toBe(false);
      });

      it('clears both sides when the token generation does not match the tenant record', async () => {
        const data = useStore({
          dataSyncConfig: {
            active: true,
            cloudTenant: cloudTenant({ generation: 'gen-1' }),
            storageMode: 'cloud',
          },
          encryptedTokens: tokens('gen-OTHER'),
        });

        controller.afterAppReady();

        expect(data.encryptedTokens).toBeUndefined();
        expect(data.dataSyncConfig).toEqual({ active: false, storageMode: 'cloud' });
        expect(await controller.getAccessToken()).toBeNull();
      });

      it('treats a tenant record without tokens as logged out but remembers it for re-login', async () => {
        const data = useStore({
          dataSyncConfig: { active: true, cloudTenant: cloudTenant(), storageMode: 'cloud' },
        });

        const config = await controller.getRemoteServerConfig();

        expect(config.active).toBe(false);
        expect((data.dataSyncConfig as { cloudTenant: unknown }).cloudTenant).toBeDefined();
      });

      it('drops a malformed tenant record together with the tokens', async () => {
        const data = useStore({
          dataSyncConfig: {
            active: true,
            cloudTenant: cloudTenant({ identity: { issuer: 'x', subject: '', tenantId: 't' } }),
            storageMode: 'cloud',
          },
          encryptedTokens: tokens('gen-1'),
        });

        const config = await controller.getRemoteServerConfig();

        expect(config.active).toBe(false);
        expect(config.cloudTenant).toBeUndefined();
        expect(data.encryptedTokens).toBeUndefined();
      });

      it('keeps a consistent session untouched', async () => {
        const data = useStore({
          dataSyncConfig: { active: true, cloudTenant: cloudTenant(), storageMode: 'cloud' },
          encryptedTokens: tokens('gen-1'),
        });

        const config = await controller.getRemoteServerConfig();

        expect(config.active).toBe(true);
        expect(data.encryptedTokens).toBeDefined();
        expect(await controller.isRemoteServerConfigured()).toBe(true);
      });
    });

    describe('configuration written by the renderer', () => {
      it('cannot set or replace the confirmed tenant record', async () => {
        const data = useStore({
          dataSyncConfig: { active: true, cloudTenant: cloudTenant(), storageMode: 'cloud' },
          encryptedTokens: tokens('gen-1'),
        });

        await controller.setRemoteServerConfig({
          active: false,
          cloudTenant: cloudTenant({ entryUrl: 'https://evil.example', generation: 'gen-evil' }),
        });

        expect(
          (data.dataSyncConfig as { cloudTenant: { entryUrl: string } }).cloudTenant.entryUrl,
        ).toBe(ENTRY);
      });

      it('logging out removes the tenant record, tokens and stops in-flight authorizations', async () => {
        const data = useStore({
          dataSyncConfig: { active: true, cloudTenant: cloudTenant(), storageMode: 'cloud' },
          encryptedTokens: tokens('gen-1'),
        });
        const onLogout = vi.fn();
        controller.onLogout(onLogout);

        await controller.clearRemoteServerConfig();

        expect(onLogout).toHaveBeenCalledTimes(1);
        expect(data.dataSyncConfig).toEqual({ active: false, storageMode: 'cloud' });
        expect(data.encryptedTokens).toBeUndefined();
      });
    });

    describe('refresh', () => {
      const loggedIn = () =>
        useStore({
          dataSyncConfig: { active: true, cloudTenant: cloudTenant(), storageMode: 'cloud' },
          encryptedTokens: tokens('gen-1'),
        });

      it('sends the refresh token only to the confirmed entry and refuses redirects', async () => {
        loggedIn();
        mockFetch.mockResolvedValue(
          new Response(
            JSON.stringify({ access_token: 'new-a', expires_in: 60, refresh_token: 'new-r' }),
            { status: 200 },
          ),
        );

        const result = await controller.refreshAccessToken();

        expect(result.success).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
          `${ENTRY}/oidc/token`,
          expect.objectContaining({ redirect: 'error' }),
        );
        // The refreshed tokens stay on the same generation.
        expect(mockStoreManager.set).toHaveBeenCalledWith(
          'encryptedTokens',
          expect.objectContaining({ generation: 'gen-1' }),
        );
      });

      it('discards a refresh response that arrives after logout', async () => {
        loggedIn();
        let respond!: (response: Response) => void;
        mockFetch.mockReturnValue(new Promise<Response>((resolve) => (respond = resolve)));

        const pending = controller.refreshAccessToken();
        await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
        await controller.clearTokens();
        respond(
          new Response(JSON.stringify({ access_token: 'late', refresh_token: 'late-r' }), {
            status: 200,
          }),
        );

        const result = await pending;

        expect(result).toMatchObject({
          error: 'Authorization changed during refresh',
          success: false,
        });
        expect(mockStoreManager.set).not.toHaveBeenCalledWith('encryptedTokens', expect.anything());
        expect(await controller.getAccessToken()).toBeNull();
      });

      it('on 409 TENANT_ENDPOINT_CHANGED pauses the session and asks for a new login', async () => {
        loggedIn();
        mockFetch.mockResolvedValue(
          new Response(
            JSON.stringify({
              activeUrl: 'https://elsewhere.example/t/acme',
              code: 'TENANT_ENDPOINT_CHANGED',
            }),
            { status: 409 },
          ),
        );

        const result = await controller.refreshAccessToken();

        expect(result.success).toBe(false);
        expect(controller.isRemoteActivityPaused()).toBe(true);
        expect(mockBrowserManager.broadcastToAllWindows).toHaveBeenCalledWith(
          'tenantEndpointChanged',
          {
            kind: 'relogin_required',
          },
        );
        expect(mockGatewayConnectionSrv.disconnect).toHaveBeenCalled();
        // Only the old, bound entry ever saw the token.
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Paused: no further refresh request is sent.
        await controller.refreshAccessToken();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        // The pause is not a revoked grant, so the tokens are not discarded for it.
        expect(controller.isNonRetryableError(result.error)).toBe(false);
      });

      it('on a standalone self-hosted server asks to update the address instead of logging in again', async () => {
        useStore({
          dataSyncConfig: {
            active: true,
            cloudTenant: cloudTenant({ entryUrl: 'https://self-host.example' }),
            remoteServerUrl: 'https://self-host.example',
            storageMode: 'selfHost',
          },
          encryptedTokens: tokens('gen-1'),
        });

        controller.handleEndpointChanged();

        expect(mockBrowserManager.broadcastToAllWindows).toHaveBeenCalledWith(
          'tenantEndpointChanged',
          {
            kind: 'update_address_required',
          },
        );
      });

      it('ignores endpoint changes when nobody is logged in', () => {
        useStore({ dataSyncConfig: { active: false, storageMode: 'cloud' } });

        controller.handleEndpointChanged();

        expect(controller.isRemoteActivityPaused()).toBe(false);
        expect(mockBrowserManager.broadcastToAllWindows).not.toHaveBeenCalledWith(
          'tenantEndpointChanged',
          expect.anything(),
        );
      });
    });
  });

  describe('official domain token injection', () => {
    const setup = async (officialServer: string) => {
      vi.resetModules();
      const onBeforeSendHeaders = vi.fn();
      vi.doMock('@/const/env', () => ({ isDev: false, OFFICIAL_CLOUD_SERVER: officialServer }));
      vi.doMock('electron', () => ({
        app: { getVersion: vi.fn(() => '1.2.3') },
        ipcMain: { handle: vi.fn() },
        safeStorage: {
          decryptString: vi.fn((buffer: Buffer) => buffer.toString()),
          encryptString: vi.fn((str: string) => Buffer.from(str)),
          isEncryptionAvailable: vi.fn(() => true),
        },
        session: { fromPartition: vi.fn(() => ({ webRequest: { onBeforeSendHeaders } })) },
      }));
      const { default: Ctr } = await import('../RemoteServerConfigCtr');
      return { ctr: new Ctr(mockApp), onBeforeSendHeaders };
    };

    it('registers the Oidc-Auth interceptor only when the official cloud is lobehub.com or a subdomain', async () => {
      for (const server of ['https://lobehub.com', 'https://app.lobehub.com']) {
        const { ctr, onBeforeSendHeaders } = await setup(server);
        await ctr.setupSubscriptionWebviewSession({ partition: 'p' });
        expect(onBeforeSendHeaders).toHaveBeenCalledTimes(1);
      }
    });

    it.each([
      'https://tituwork.zxaimall.cn',
      'https://evil-lobehub.com',
      'https://lobehub.com.evil.example',
    ])('does not register it for %s', async (server) => {
      const { ctr, onBeforeSendHeaders } = await setup(server);

      expect(await ctr.setupSubscriptionWebviewSession({ partition: 'p' })).toEqual({
        skipped: true,
        success: true,
      });
      expect(onBeforeSendHeaders).not.toHaveBeenCalled();
    });
  });
});
