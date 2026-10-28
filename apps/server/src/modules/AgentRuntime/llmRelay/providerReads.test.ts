// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertGatewayProviderCapability,
  resolveLlmExecutionSite,
  resolveProviderRelay,
} from './resolveLlmExecutionSite';

const row = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const read = vi.hoisted(() => vi.fn(async () => row.value));
vi.mock('@/database/models/aiProvider', () => ({
  AiProviderModel: class {
    getAiProviderById = read;
  },
}));
vi.mock('@/server/modules/KeyVaultsEncrypt', () => ({
  KeyVaultsGateKeeper: { getUserKeyVaults: vi.fn() },
}));
vi.mock('@/server/modules/ModelRuntime', () => ({ resolveRuntimeProvider: (id: string) => id }));

const params = (provider: string) => ({ db: {} as never, provider, userId: 'test-user' });
describe('provider relay capability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    row.value = {};
  });

  it.each(['cloudflare', 'openrouter'])(
    'does not read provider rows for server-only %s',
    async (provider) => {
      expect(await resolveLlmExecutionSite(params(provider))).toEqual({ site: 'server' });
      expect(await resolveProviderRelay(params(provider))).toBeUndefined();
      await assertGatewayProviderCapability({} as never, 'test-user', provider);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('rejects device providers in one-shot and agent request entry paths', async () => {
    await expect(resolveProviderRelay(params('ollama'))).rejects.toMatchObject({
      code: 'LLM_RELAY_UNSUPPORTED',
      status: 501,
    });
    await expect(
      assertGatewayProviderCapability({} as never, 'test-user', 'ollama'),
    ).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
      message: 'LLM_RELAY_UNSUPPORTED',
    });
    expect(await resolveLlmExecutionSite(params('ollama'))).toEqual({
      reason: 'relay_unsupported',
      site: 'unavailable',
    });
  });

  it('still detects client fetch configured on a normally hosted provider', async () => {
    row.value = { fetchOnClient: true, keyVaults: { apiKey: 'test-only' } };
    await expect(resolveProviderRelay(params('openai'))).rejects.toMatchObject({
      code: 'LLM_RELAY_UNSUPPORTED',
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
