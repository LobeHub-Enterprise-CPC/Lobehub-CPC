import { runWithTenantScope } from '@lobechat/database/tenant';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TenantGateError } from '@/server/modules/Tenant/errors';
import { getTenantLiveResources } from '@/server/modules/Tenant/liveResources';
import type { PlatformDefinition } from '@/server/services/bot/platforms';

import { createGatewayManager } from './GatewayManager';

vi.mock('@/server/modules/Tenant/runtime', () => ({
  getTenantRuntime: () => ({ assertAdmitted: vi.fn(async () => {}) }),
}));

vi.mock('@/server/modules/Tenant/postgresClaims', () => ({
  heartbeatTenantProcess: vi.fn(),
  tenantClaims: { bind: () => async () => {}, enter: async () => async () => {} },
}));

// Callbacks are addressed to the test tenant `acme` (see __mocks__/callbackUrl).
vi.mock('@/server/modules/Tenant/callbackUrl');

const mockFindEnabledByPlatform = vi.hoisted(() => vi.fn());
const mockFindEnabledByPlatformAndAppId = vi.hoisted(() => vi.fn());
const mockInitWithEnvKey = vi.hoisted(() => vi.fn());
const mockGetServerDB = vi.hoisted(() => vi.fn());
const mockIsBotFeatureAccessAllowed = vi.hoisted(() => vi.fn());
const mockUpdateBotRuntimeStatus = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: mockGetServerDB,
}));

vi.mock('@/database/models/agentBotProvider', () => {
  const MockModel = vi.fn();
  (MockModel as any).findEnabledByPlatform = mockFindEnabledByPlatform;
  (MockModel as any).findEnabledByPlatformAndAppId = mockFindEnabledByPlatformAndAppId;
  return { AgentBotProviderModel: MockModel };
});

vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: {
    initWithEnvKey: mockInitWithEnvKey,
  },
}));

vi.mock('@/business/server/bot/featureAccess', () => ({
  getBotFeatureBlockedMessage: vi.fn(function () {
    return 'blocked';
  }),
  isBotFeatureAccessAllowed: mockIsBotFeatureAccessAllowed,
}));

vi.mock('./runtimeStatus', () => ({
  BOT_RUNTIME_STATUSES: { failed: 'failed' },
  updateBotRuntimeStatus: mockUpdateBotRuntimeStatus,
}));

// Fake platform definition for testing
const mockStartedClient = vi.hoisted(() => ({
  applicationId: 'app-1',
  createAdapter: () => ({}),
  extractChatId: (id: string) => id,
  getMessenger: () => ({
    createMessage: async () => {},
    editMessage: async () => {},
    removeReaction: async () => {},
    triggerTyping: async () => {},
  }),
  parseMessageId: (id: string) => id,
  id: 'fakeplatform',
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
}));

const fakeDefinition: PlatformDefinition = {
  clientFactory: {
    createClient: () => mockStartedClient,
    validateCredentials: async () => ({ valid: true }),
    validateSettings: async () => ({ valid: true }),
  },
  credentials: [],
  name: 'Fake Platform',
  id: 'fakeplatform',
  schema: [],
} as any;

const FAKE_DB = {} as any;
const FAKE_GATEKEEPER = { decrypt: vi.fn() };

describe('GatewayManager tenant suspension', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetServerDB.mockResolvedValue(FAKE_DB);
    mockInitWithEnvKey.mockResolvedValue(FAKE_GATEKEEPER);
    mockFindEnabledByPlatform.mockResolvedValue([]);
    mockFindEnabledByPlatformAndAppId.mockResolvedValue(null);
    mockIsBotFeatureAccessAllowed.mockResolvedValue(true);
  });
  it("stops the tenant's bot connections on freeze and restarts them on resume", async () => {
    const scope = { session: {} as any, slug: 'acme', tenantId: 't-gateway' };
    const tenantManager = runWithTenantScope(scope, () =>
      createGatewayManager({ definitions: [fakeDefinition] }),
    );
    await runWithTenantScope(scope, () => tenantManager.start());
    expect(tenantManager.isRunning).toBe(true);

    await getTenantLiveResources().suspend('t-gateway', new TenantGateError('TENANT_FROZEN'));
    expect(tenantManager.isRunning).toBe(false);

    await getTenantLiveResources().resume('t-gateway');
    expect(tenantManager.isRunning).toBe(true);
    await tenantManager.stop();
  });
});
