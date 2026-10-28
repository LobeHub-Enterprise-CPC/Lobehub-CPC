import { afterEach, describe, expect, it, vi } from 'vitest';

import { gatewayOperationPost } from './gatewayHttp';
import { GatewayStreamNotifier } from './GatewayStreamNotifier';
import type { IStreamEventManager } from './types';

const deps = vi.hoisted(() => ({ scope: vi.fn(), operation: vi.fn() }));
vi.mock('@lobechat/database/tenant', () => ({ requireTenantScope: deps.scope }));
vi.mock('@/server/services/gatewayAuthorization/operationAuthority', () => ({
  loadGatewayOperation: deps.operation,
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
describe('tenancy HTTP relay capability entry', () => {
  it.each([
    '/api/operations/llm-execute',
    '/api/operations/llm-cancel',
    '/api/operations/llm-close',
  ])('rejects %s before redis, database or HTTP', async (path) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      gatewayOperationPost(
        'https://gw.invalid',
        'TEST-ONLY',
        path,
        { operationId: 'operation' },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'LLM_RELAY_UNSUPPORTED', status: 501 });
    expect(fetch).not.toHaveBeenCalled();
    expect(deps.scope).not.toHaveBeenCalled();
    expect(deps.operation).not.toHaveBeenCalled();
  });
  it('rejects the retained notifier one-shot open before creating a channel', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const notifier = new GatewayStreamNotifier(
      {} as IStreamEventManager,
      'https://gw.invalid',
      'TEST-ONLY',
    );
    await expect(
      notifier.openLlmRelayChannel('llmcall:user:abcdefgh', 'user'),
    ).rejects.toMatchObject({ code: 'LLM_RELAY_UNSUPPORTED', status: 501 });
    expect(fetch).not.toHaveBeenCalled();
    expect(deps.operation).not.toHaveBeenCalled();
  });
});
