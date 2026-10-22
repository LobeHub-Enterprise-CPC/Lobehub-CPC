import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getMessengerTelegramConfig,
  getMessengerWechatConfig,
  invalidateMessengerConfigCache,
} from './messenger';

const {
  gatewayEnvState,
  mockFindEnabledByPlatform,
  mockGetServerDB,
  mockInitWithEnvKey,
  redisEnvState,
} = vi.hoisted(() => ({
  gatewayEnvState: {
    MESSAGE_GATEWAY_ENABLED: '1' as string | undefined,
    MESSAGE_GATEWAY_NODE_PLATFORMS: undefined as string | undefined,
    MESSAGE_GATEWAY_NODE_URL: undefined as string | undefined,
    MESSAGE_GATEWAY_SERVICE_TOKEN: 'gateway-token' as string | undefined,
    MESSAGE_GATEWAY_URL: 'https://gateway.example.com' as string | undefined,
  },
  mockFindEnabledByPlatform: vi.fn(),
  mockGetServerDB: vi.fn(),
  mockInitWithEnvKey: vi.fn(),
  redisEnvState: { REDIS_URL: 'redis://localhost:6379' as string | undefined },
}));

vi.mock('@/envs/gateway', () => ({ gatewayEnv: gatewayEnvState }));
vi.mock('@/envs/redis', () => ({ redisEnv: redisEnvState }));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: mockGetServerDB }));
vi.mock('@/database/models/systemBotProvider', () => ({
  SystemBotProviderModel: { findEnabledByPlatform: mockFindEnabledByPlatform },
}));
vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { initWithEnvKey: mockInitWithEnvKey },
}));

describe('getMessengerWechatConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    invalidateMessengerConfigCache();
    gatewayEnvState.MESSAGE_GATEWAY_ENABLED = '1';
    gatewayEnvState.MESSAGE_GATEWAY_URL = 'https://gateway.example.com';
    gatewayEnvState.MESSAGE_GATEWAY_SERVICE_TOKEN = 'gateway-token';
    gatewayEnvState.MESSAGE_GATEWAY_NODE_URL = undefined;
    gatewayEnvState.MESSAGE_GATEWAY_NODE_PLATFORMS = undefined;
    redisEnvState.REDIS_URL = 'redis://localhost:6379';
    mockGetServerDB.mockResolvedValue({});
    mockInitWithEnvKey.mockResolvedValue({});
    mockFindEnabledByPlatform.mockResolvedValue({ platform: 'wechat' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the enabled provider when all polling prerequisites are configured', async () => {
    await expect(getMessengerWechatConfig()).resolves.toEqual({ enabled: true });
    expect(mockFindEnabledByPlatform).toHaveBeenCalledWith({}, 'wechat', {});
  });

  it.each([
    ['gateway disabled', () => (gatewayEnvState.MESSAGE_GATEWAY_ENABLED = '0')],
    ['gateway URL missing', () => (gatewayEnvState.MESSAGE_GATEWAY_URL = undefined)],
    ['gateway token missing', () => (gatewayEnvState.MESSAGE_GATEWAY_SERVICE_TOKEN = undefined)],
    ['Redis URL missing', () => (redisEnvState.REDIS_URL = undefined)],
    ['Redis explicitly disabled', () => vi.stubEnv('DISABLE_REDIS', '1')],
  ])('does not advertise WeChat when %s', async (_case, arrange) => {
    arrange();

    await expect(getMessengerWechatConfig()).resolves.toBeNull();
    expect(mockFindEnabledByPlatform).not.toHaveBeenCalled();
  });

  it('advertises WeChat when it is routed to the node host and the default host is live', async () => {
    // The cutover shape. WeChat's connection lives on the Node gateway while
    // the default host still carries every other platform.
    gatewayEnvState.MESSAGE_GATEWAY_NODE_URL = 'https://node-gateway.example.com';
    gatewayEnvState.MESSAGE_GATEWAY_NODE_PLATFORMS = 'wechat';

    await expect(getMessengerWechatConfig()).resolves.toEqual({ enabled: true });
  });

  it('does not advertise WeChat on a node-only deployment', async () => {
    // The runtime only enters gateway mode with a configured default host, so
    // here nothing would ever serve these links — advertising WeChat would
    // offer users a channel that silently never connects.
    gatewayEnvState.MESSAGE_GATEWAY_URL = undefined;
    gatewayEnvState.MESSAGE_GATEWAY_NODE_URL = 'https://node-gateway.example.com';
    gatewayEnvState.MESSAGE_GATEWAY_NODE_PLATFORMS = 'wechat';

    await expect(getMessengerWechatConfig()).resolves.toBeNull();
    expect(mockFindEnabledByPlatform).not.toHaveBeenCalled();
  });
});

describe('messenger config cache tenant isolation', () => {
  const inTenant = <T>(tenantId: string, fn: () => T) =>
    runWithTenantScope({ session: {}, slug: tenantId, tenantId } as unknown as TenantScope, fn);

  const row = (botToken: string) => ({
    credentials: { botToken },
    platform: 'telegram',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateMessengerConfigCache();
    mockGetServerDB.mockResolvedValue({});
    mockInitWithEnvKey.mockResolvedValue({});
    mockFindEnabledByPlatform.mockImplementation(async () => {
      const { currentTenantScope } = await import('@lobechat/database/tenant');
      return row(`token-of-${currentTenantScope()?.tenantId}`);
    });
  });

  it('never serves one tenant the credentials cached for another', async () => {
    const a = await inTenant('tenant-a', () => getMessengerTelegramConfig());
    const b = await inTenant('tenant-b', () => getMessengerTelegramConfig());

    expect(a?.botToken).toBe('token-of-tenant-a');
    expect(b?.botToken).toBe('token-of-tenant-b');
  });

  it('still caches within one tenant', async () => {
    await inTenant('tenant-a', () => getMessengerTelegramConfig());
    await inTenant('tenant-a', () => getMessengerTelegramConfig());

    expect(mockFindEnabledByPlatform).toHaveBeenCalledTimes(1);
  });

  it('invalidates only the given tenant', async () => {
    await inTenant('tenant-a', () => getMessengerTelegramConfig());
    await inTenant('tenant-b', () => getMessengerTelegramConfig());
    mockFindEnabledByPlatform.mockClear();

    invalidateMessengerConfigCache('telegram', 'tenant-a');

    await inTenant('tenant-b', () => getMessengerTelegramConfig());
    expect(mockFindEnabledByPlatform).not.toHaveBeenCalled();
    await inTenant('tenant-a', () => getMessengerTelegramConfig());
    expect(mockFindEnabledByPlatform).toHaveBeenCalledTimes(1);
  });

  it('invalidates the current tenant by default', async () => {
    await inTenant('tenant-a', () => getMessengerTelegramConfig());
    await inTenant('tenant-b', () => getMessengerTelegramConfig());
    mockFindEnabledByPlatform.mockClear();

    inTenant('tenant-a', () => invalidateMessengerConfigCache('telegram'));

    await inTenant('tenant-b', () => getMessengerTelegramConfig());
    expect(mockFindEnabledByPlatform).not.toHaveBeenCalled();
    await inTenant('tenant-a', () => getMessengerTelegramConfig());
    expect(mockFindEnabledByPlatform).toHaveBeenCalledTimes(1);
  });

  it('does not cache outside a tenant scope', async () => {
    mockFindEnabledByPlatform.mockResolvedValue(row('no-scope-token'));
    await getMessengerTelegramConfig();
    await getMessengerTelegramConfig();

    expect(mockFindEnabledByPlatform).toHaveBeenCalledTimes(2);
  });
});
