import type * as LobechatConstModule from '@lobechat/const';
import { type Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { lambdaClient } from '@/libs/trpc/client';
import { useElectronStore } from '@/store/electron';
import { type GlobalRuntimeConfig } from '@/types/serverConfig';

import { globalService } from '../global';

global.fetch = vi.fn();

const mockConstEnv = vi.hoisted(() => ({ isDesktop: false }));

vi.mock('@lobechat/const', async (importOriginal) => {
  const actual = await importOriginal<typeof LobechatConstModule>();
  return {
    ...actual,
    get isDesktop() {
      return mockConstEnv.isDesktop;
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  mockConstEnv.isDesktop = false;
});

vi.mock('@/libs/trpc/client', () => {
  return {
    lambdaClient: {
      config: {
        getGlobalConfig: { query: vi.fn() },
        getDefaultAgentConfig: { query: vi.fn() },
      },
    },
  };
});

describe('GlobalService', () => {
  describe('getLatestVersion', () => {
    it('should return the latest version when fetch is successful', async () => {
      // Arrange
      const mockVersion = '1.0.0';
      (fetch as Mock).mockResolvedValue({
        json: () => Promise.resolve({ version: mockVersion }),
      });

      // Act
      const version = await globalService.getLatestVersion();

      // Assert
      expect(fetch).toHaveBeenCalledWith('https://registry.npmmirror.com/@lobehub/chat/latest');
      expect(version).toBe(mockVersion);
    });

    it('should return undefined if the latest version is not found in the response', async () => {
      // Arrange
      (fetch as Mock).mockResolvedValue({
        json: () => Promise.resolve({}),
      });

      // Act
      const version = await globalService.getLatestVersion();

      // Assert
      expect(version).toBeUndefined();
    });

    it('should throw an error when the fetch call fails', async () => {
      // Arrange
      (fetch as Mock).mockRejectedValue(new Error('Network error'));

      // Act & Assert
      await expect(globalService.getLatestVersion()).rejects.toThrow('Network error');
    });

    it('should handle non-JSON responses gracefully', async () => {
      // Arrange
      (fetch as Mock).mockResolvedValue({
        json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0')),
      });

      // Act & Assert
      await expect(globalService.getLatestVersion()).rejects.toThrow(SyntaxError);
    });
  });

  describe('getServerVersion', () => {
    const connect = (remoteServerUrl?: string) => {
      mockConstEnv.isDesktop = true;
      useElectronStore.setState({
        dataSyncConfig: { remoteServerUrl, storageMode: 'selfHost' },
      });
      (fetch as Mock).mockResolvedValue({
        json: () => Promise.resolve({ version: '2.1.0' }),
        ok: true,
        status: 200,
      });
    };

    it.each([
      ['https://host/orgs/acme', 'https://host/orgs/acme/api/version'],
      ['https://host/orgs/acme/', 'https://host/orgs/acme/api/version'],
      ['http://127.0.0.1:3210/orgs/acme', 'http://127.0.0.1:3210/orgs/acme/api/version'],
      ['https://custom.host', 'https://custom.host/api/version'],
      ['https://custom.host/', 'https://custom.host/api/version'],
    ])('asks the tenant address %s, keeping its path prefix', async (remote, expectedUrl) => {
      connect(remote);

      await expect(globalService.getServerVersion()).resolves.toBe('2.1.0');

      expect(fetch).toHaveBeenCalledWith(expectedUrl);
    });

    it('does not ask anyone when no remote server is configured', async () => {
      connect(undefined);

      await expect(globalService.getServerVersion()).resolves.toBeNull();

      expect(fetch).not.toHaveBeenCalled();
    });

    it('does not ask a remote server outside the desktop app', async () => {
      connect('https://host/orgs/acme');
      mockConstEnv.isDesktop = false;

      await expect(globalService.getServerVersion()).resolves.toBeNull();

      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('ServerConfig', () => {
    it('should return the serverConfig when fetch is successful', async () => {
      // Arrange
      const mockConfig = {
        serverConfig: { enabledOAuthSSO: true },
        serverFeatureFlags: {},
      } as GlobalRuntimeConfig;
      vi.spyOn(lambdaClient.config.getGlobalConfig, 'query').mockResolvedValue(mockConfig);

      // Act
      const config = await globalService.getGlobalConfig();

      // Assert
      expect(config).toEqual(mockConfig);
    });

    it('should return the defaultAgentConfig when fetch is successful', async () => {
      // Arrange
      vi.spyOn(lambdaClient.config.getDefaultAgentConfig, 'query').mockResolvedValue({
        model: 'gemini-pro',
      });

      // Act
      const config = await globalService.getDefaultAgentConfig();

      // Assert
      expect(config).toEqual({ model: 'gemini-pro' });
    });
  });
});
