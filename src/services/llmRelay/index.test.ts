import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildLlmExecutorDeclaration, oneShotRelay } from './index';

const state = vi.hoisted(() => ({
  aiInfra: {} as Record<string, unknown>,
  featureFlags: {} as Record<string, unknown>,
  serverConfig: {} as Record<string, unknown>,
}));

vi.mock('@/store/aiInfra', () => ({
  aiProviderSelectors: {
    isProviderFetchOnClient: (provider: string) => () => provider === 'ollama',
  },
  getAiInfraStoreState: () => state.aiInfra,
}));
vi.mock('@/store/serverConfig', () => ({
  getServerConfigStoreState: () => ({
    featureFlags: state.featureFlags,
    serverConfig: state.serverConfig,
  }),
}));
vi.mock('@/store/user', () => ({ useUserStore: { getState: () => ({}) } }));
vi.mock('@/store/user/selectors', () => ({ userProfileSelectors: { userId: () => 'user-1' } }));
vi.mock('./clientId', () => ({ getLlmRelayClientId: () => 'tab-1' }));

describe('buildLlmExecutorDeclaration', () => {
  beforeEach(() => {
    state.featureFlags = { enableLlmRelay: true };
    // A chat page loads the runtime state only; the settings-page provider
    // list stays empty there.
    state.aiInfra = {
      aiProviderList: [],
      enabledAiProviders: [{ id: 'lmstudio' }, { id: 'ollama' }],
    };
  });

  it('does not advertise relay execution even with the old rollout flag enabled', () => {
    expect(buildLlmExecutorDeclaration()).toBeUndefined();
  });

  it('declares nothing outside the agent_llm_relay rollout', () => {
    state.featureFlags = { enableLlmRelay: false };
    expect(buildLlmExecutorDeclaration()).toBeUndefined();
  });
});

describe('oneShotRelay availability', () => {
  beforeEach(() => {
    state.featureFlags = { enableLlmRelay: true };
    state.serverConfig = { agentGatewayUrl: 'https://gw', llmRelayAvailable: true };
  });

  it('keeps relay disabled even when a stale configuration advertises availability', () => {
    expect(oneShotRelay.needsRelay('ollama')).toBe(false);
    expect(oneShotRelay.needsRelay('openai')).toBe(false);
  });

  // A gateway URL without Redis: the server cannot relay and would call the
  // device-only provider itself, so the browser keeps its own fallback.
  it('keeps the browser fallback where the server cannot relay', () => {
    state.serverConfig = { agentGatewayUrl: 'https://gw', llmRelayAvailable: false };
    expect(oneShotRelay.needsRelay('ollama')).toBe(false);
  });
});
