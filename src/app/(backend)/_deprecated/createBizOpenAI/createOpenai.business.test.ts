// @vitest-environment node
import { ChatErrorType } from '@lobechat/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenai } from './createOpenai';

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ENABLE_BUSINESS_FEATURES: true,
}));
vi.mock('@/envs/llm', () => ({ getLLMConfig: () => ({ OPENAI_API_KEY: 'instance-openai-key' }) }));

afterEach(() => {
  delete process.env.OPENAI_PROXY_URL;
});

describe('createOpenai in business (multi-tenant) builds', () => {
  it('never lends the instance OpenAI key to a caller without its own', () => {
    expect(() => createOpenai(null)).toThrowError(
      expect.objectContaining({ cause: ChatErrorType.NoOpenAIAPIKey }),
    );
  });

  it("uses the caller's key without the instance proxy", () => {
    process.env.OPENAI_PROXY_URL = 'https://platform-proxy.example.com/v1';

    const openai = createOpenai('user-key');

    expect(openai.apiKey).toBe('user-key');
    expect(openai.baseURL).not.toBe('https://platform-proxy.example.com/v1');
  });
});
