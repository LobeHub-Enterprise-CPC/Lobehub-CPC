import { beforeEach, describe, expect, it, vi } from 'vitest';

import { aiAgentService } from '@/services/aiAgent';

import { createBrowserGatewayIdentityProvider } from './identityProvider';

vi.mock('@/services/aiAgent', () => ({ aiAgentService: { refreshGatewayToken: vi.fn() } }));
const ticket = (authorizationId = 'original') =>
  `TEST.${btoa(JSON.stringify({ iss: 'urn:lobehub:gateway-session', purpose: 'gateway-connect', aud: 'urn:lobehub:gateway:agent', tid: 'tenant', sub: 'user', principal: { kind: 'user', id: 'user' }, capabilities: ['agent:observe', 'agent:respond', 'agent:execute'], authorization_id: authorizationId, accepted_version: 7, operation_id: 'operation', exp: Math.floor(Date.now() / 1000) + 300 }))}.TEST`;
const provider = () =>
  createBrowserGatewayIdentityProvider({
    token: ticket(),
    topicId: 'topic',
    operationId: 'operation',
  });
beforeEach(() => vi.clearAllMocks());
describe('browser original-source identity provider', () => {
  it('renews using the same authorization ID', async () => {
    const getIdentity = provider();
    const signal = new AbortController().signal;
    const first = await getIdentity({ signal });
    vi.mocked(aiAgentService.refreshGatewayToken).mockResolvedValue({ token: ticket() });
    const next = await getIdentity({ signal, renewAuthorizationId: first.authorizationId });
    expect(aiAgentService.refreshGatewayToken).toHaveBeenCalledWith('topic', first.authorizationId);
    expect(next.authorizationId).toBe(first.authorizationId);
  });
  it('rejects a substituted authorization response', async () => {
    const getIdentity = provider();
    const signal = new AbortController().signal;
    await getIdentity({ signal });
    vi.mocked(aiAgentService.refreshGatewayToken).mockResolvedValue({
      token: ticket('replacement'),
    });
    await expect(getIdentity({ signal, renewAuthorizationId: 'original' })).rejects.toThrow(
      'SOURCE_UNVERIFIABLE',
    );
  });
  it('does not return a late ticket after the original signal aborts', async () => {
    const getIdentity = provider();
    const controller = new AbortController();
    await getIdentity({ signal: controller.signal });
    let resolve!: (value: { token: string }) => void;
    vi.mocked(aiAgentService.refreshGatewayToken).mockImplementation(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const pending = getIdentity({ signal: controller.signal });
    controller.abort();
    resolve({ token: ticket() });
    await expect(pending).rejects.toThrow();
  });
});
