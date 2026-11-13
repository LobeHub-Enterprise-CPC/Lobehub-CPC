import { describe, expect, it, vi } from 'vitest';

import { aiAgentService } from '@/services/aiAgent';
import { getGatewayMux } from '@/store/chat/slices/agentRun/actions/transports/gateway/muxRegistry';

import { subscribeLlmRelayChannel } from './channelSubscription';

vi.mock('@/store/serverConfig', () => ({
  getServerConfigStoreState: () => ({ serverConfig: { agentGatewayProtocol: 2 } }),
}));
vi.mock('@/services/aiAgent', () => ({
  aiAgentService: { issueGatewayUserToken: vi.fn() },
}));
vi.mock('@/store/chat/slices/agentRun/actions/transports/gateway/muxRegistry', () => ({
  getGatewayMux: vi.fn(),
  isGatewayMuxUnavailable: () => false,
  markGatewayMuxUnavailable: vi.fn(),
}));

describe('subscribeLlmRelayChannel', () => {
  it('refuses relay under protocol 2 before minting or opening any subscription', async () => {
    await expect(subscribeLlmRelayChannel('https://gw', 'llmcall:u:1', vi.fn())).rejects.toThrow(
      'LLM_RELAY_UNSUPPORTED',
    );
    expect(getGatewayMux).not.toHaveBeenCalled();
    expect(aiAgentService.issueGatewayUserToken).not.toHaveBeenCalled();
  });
});
