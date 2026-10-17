import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ConstVersion from '@/const/version';

import { GatewayActionImpl } from './gateway';

vi.mock('@/services/aiAgent', () => ({
  aiAgentService: {
    execAgentTask: vi.fn(),
    interruptTask: vi.fn(),
    issueGatewayUserToken: vi.fn(),
    refreshGatewayToken: vi.fn(),
  },
}));

vi.mock('@/services/shareChat', () => ({
  shareChatService: {
    execAgentTask: vi.fn(),
    interruptTask: vi.fn(),
    issueGatewayUserToken: vi.fn(),
    refreshGatewayToken: vi.fn(),
  },
}));

vi.mock('@/services/message', () => ({
  messageService: { getMessages: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/services/topic', () => ({
  topicService: {
    getTopicDetail: vi.fn().mockResolvedValue(null),
    settleRunningOperation: vi.fn().mockResolvedValue(undefined),
    updateTopicMetadata: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/store/file/store', () => ({
  getFileStoreState: () => ({ moveChatContextSelections: vi.fn() }),
}));

const mockUserState = vi.hoisted(() => ({
  profile: { id: 'user-1' },
  workspaceUserPreference: { agentDeviceOverrides: {} as Record<string, any> },
}));

vi.mock('@/store/user', () => ({
  getUserStoreState: vi.fn(() => mockUserState),
  useUserStore: { getState: vi.fn(() => mockUserState) },
}));

vi.mock('@/store/user/selectors', () => ({
  settingsSelectors: { defaultAgentConfig: () => ({ chatConfig: {} }) },
  toolInterventionSelectors: { allowList: () => [], approvalMode: () => 'manual' },
  userGeneralSettingsSelectors: { telemetry: () => false },
  userProfileSelectors: { userId: (state: typeof mockUserState) => state.profile.id },
}));

vi.mock('@/const/version', async (importOriginal) => ({
  ...(await importOriginal<typeof ConstVersion>()),
  isDesktop: false,
}));

vi.mock('@/services/electron/gatewayConnection', () => ({
  gatewayConnectionService: { getDeviceInfo: vi.fn() },
}));

vi.mock('@/store/agent', () => ({
  getAgentStoreState: () => ({ activeAgentId: undefined, agentMap: {} }),
}));

vi.mock('@/store/agent/selectors', () => ({
  agentByIdSelectors: {
    getAgencyConfigById: () => () => undefined,
    getAgentById: () => () => undefined,
  },
  agentSelectors: {
    currentAgentWorkingDirectory: () => () => undefined,
    getAgentConfigById: () => () => undefined,
  },
  chatConfigByIdSelectors: {
    getChatConfigById: () => () => ({}),
    isChatModeById: () => () => false,
    isLocalSystemEnabledById: () => () => false,
  },
}));

vi.mock('@/store/chat', () => ({
  useChatStore: { getState: () => ({ topicDataMap: {}, topicDetailMap: {} }) },
}));

const createAction = () => {
  const state = { gatewayConnections: {}, gatewayFeed: {} };
  const set = (updater: unknown) =>
    Object.assign(state, typeof updater === 'function' ? updater(state) : updater);
  const action = new GatewayActionImpl(set as never, (() => state) as never, undefined);
  const client = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    reconnect: vi.fn(),
    sendToolResult: vi.fn(),
    updateToken: vi.fn(),
  };
  action.createClient = vi.fn(() => client as never);
  action.resolveGatewayMux = vi.fn();
  action.createMuxClient = vi.fn();
  return { action, client };
};
beforeEach(() => {
  Object.assign(globalThis, {
    window: {
      global_serverConfigStore: {
        getState: () => ({
          featureFlags: { enableGatewayMux: true },
          serverConfig: {
            agentGatewayProtocol: 2,
            agentGatewayUrl: 'https://gw.invalid',
            enableGatewayMode: true,
          },
        }),
      },
    },
  });
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});
describe('tenancy gateway capability entries', () => {
  it('does not construct or dial a mux during browser warmup with stale upstream flags', () => {
    const { action } = createAction();
    action.warmupGatewayMux();
    expect(action.resolveGatewayMux).not.toHaveBeenCalled();
  });
  it.each([undefined, 'share-visitor'])(
    'does not select mux for operation connection (share=%s)',
    (agentShareId) => {
      const { action, client } = createAction();
      action.connectToGateway({
        agentShareId,
        gatewayUrl: 'https://gw.invalid',
        operationId: 'operation',
        token: 'TEST-ONLY',
        topicId: 'topic',
      });
      expect(action.resolveGatewayMux).not.toHaveBeenCalled();
      expect(action.createMuxClient).not.toHaveBeenCalled();
      expect(action.createClient).toHaveBeenCalledWith(
        expect.objectContaining({ identityProvider: expect.any(Function) }),
      );
      expect(client.connect).toHaveBeenCalledOnce();
    },
  );
});
