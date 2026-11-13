import { afterEach, describe, expect, it, vi } from 'vitest';

import { aiAgentService } from './aiAgent';

const mocks = vi.hoisted(() => ({ protocol: 1, exec: vi.fn(), append: vi.fn(), token: vi.fn() }));
vi.mock('@/store/serverConfig', () => ({
  getServerConfigStoreState: () => ({
    featureFlags: { enableGatewayMux: false },
    serverConfig: { agentGatewayProtocol: mocks.protocol },
  }),
}));
vi.mock('@/services/llmRelay', () => ({ buildLlmExecutorDeclaration: () => undefined }));
vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: {
    aiAgent: { execAgent: { mutate: mocks.exec }, issueGatewayUserToken: { query: mocks.token } },
    agentSteerQueue: { append: { mutate: mocks.append } },
  },
}));
afterEach(() => vi.clearAllMocks());
describe('gateway protocol declarations', () => {
  it.each([1, 2])(
    'declares clientProtocol only for server protocol %s without rollout',
    async (protocol) => {
      mocks.protocol = protocol;
      await aiAgentService.execAgentTask({ agentId: 'agent', prompt: 'hello' });
      expect(mocks.exec.mock.calls[0][0].clientProtocol).toBe(protocol === 2 ? 2 : undefined);
      expect(mocks.exec.mock.calls[0][0].llmExecutor).toBeUndefined();
      await aiAgentService.appendQueuedFollowUp({
        id: 'follow-up',
        request: { prompt: 'hello' } as never,
      });
      expect(mocks.append.mock.calls[0][0].request.clientProtocol).toBe(
        protocol === 2 ? 2 : undefined,
      );
    },
  );
  it('sends the connection and original authorization to the USER ticket endpoint', async () => {
    mocks.token.mockResolvedValue({ token: 'placeholder' });
    await expect(
      aiAgentService.issueGatewayUserToken({ clientId: 'tab', authorizationId: 'auth' }),
    ).resolves.toEqual({ token: 'placeholder' });
    expect(mocks.token).toHaveBeenCalledWith({ clientId: 'tab', authorizationId: 'auth' });
  });
});
