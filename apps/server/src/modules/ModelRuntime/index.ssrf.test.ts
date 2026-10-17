// @vitest-environment node
import net from 'node:net';

import { ENABLE_BUSINESS_FEATURES } from '@lobechat/business-const';
import { ModelProvider } from 'model-bank';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initModelRuntimeWithUserPayload } from './index';

vi.mock('@/business/client/model-bank/loadModels', () => ({ loadModels: vi.fn() }));
vi.mock('@/server/globalConfig', () => ({ getServerGlobalConfig: vi.fn() }));
vi.mock('@/envs/llm', () => ({
  getLLMConfig: vi.fn(() => ({
    ANTHROPIC_API_KEY: 'platform-anthropic-key',
    GOOGLE_API_KEY: 'platform-google-key',
    OPENAI_API_KEY: 'platform-openai-key',
  })),
}));

/**
 * Every outbound TCP connection the process tries to open ends up in
 * `net.Socket.prototype.connect` (undici and http.Agent alike). Record the
 * targets and fail them locally so the tests never touch a real network.
 */
const connectTargets: string[] = [];

beforeEach(() => {
  connectTargets.length = 0;
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: any[]
  ) {
    // net.connect() hands the normalized `[options, cb]` pair through as one array.
    const [first, second] = Array.isArray(args[0]) ? args[0] : args;
    const host = typeof first === 'object' && first ? first.host : second;
    const port = typeof first === 'object' && first ? first.port : first;
    connectTargets.push(`${host}:${port}`);
    this.destroy(new Error('network disabled in test'));
    return this;
  } as any);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENAI_PROXY_URL;
  delete process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS;
});

const chatPayload = {
  messages: [{ content: 'hi', role: 'user' as const }],
  model: 'test-model',
  temperature: 1,
};

const forbiddenBaseURLs = [
  'http://169.254.169.254/latest/meta-data',
  'http://127.0.0.1:8080/v1',
  'http://10.0.0.8/v1',
  'http://192.168.1.10:11434',
  'http://172.16.0.5/v1',
];

describe('user-provided provider baseURL is SSRF-guarded', () => {
  describe.each([
    ModelProvider.OpenAI,
    ModelProvider.Anthropic,
    ModelProvider.Ollama,
    ModelProvider.Google,
    ModelProvider.Azure,
  ])('%s', (provider) => {
    it.each(forbiddenBaseURLs)('never connects to %s', async (baseURL) => {
      const runtime = initModelRuntimeWithUserPayload(
        provider,
        { apiKey: 'user-key', baseURL },
        { userId: 'tenant-user' },
      );

      await expect(runtime.chat(chatPayload as any)).rejects.toBeDefined();

      expect(connectTargets).toEqual([]);
    });
  });

  it('lets the deployment opt in to private targets with SSRF_ALLOW_PRIVATE_IP_ADDRESS', async () => {
    process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS = '1';

    const runtime = initModelRuntimeWithUserPayload(
      ModelProvider.OpenAI,
      { apiKey: 'user-key', baseURL: 'http://10.0.0.8/v1' },
      { userId: 'tenant-user' },
    );
    await expect(runtime.chat(chatPayload as any)).rejects.toBeDefined();

    expect(connectTargets).toContain('10.0.0.8:80');
  });
});

describe('platform-configured endpoints are not blocked', () => {
  // Business builds never lend instance provider settings to a tenant.
  it('uses the env proxy URL without a user baseURL only outside business builds', async () => {
    process.env.OPENAI_PROXY_URL = 'http://127.0.0.1:18080/v1';

    // Business builds have no instance key, so the runtime already fails to initialize.
    const chat = async () =>
      initModelRuntimeWithUserPayload(ModelProvider.OpenAI, {}, { userId: 'tenant-user' }).chat(
        chatPayload as any,
      );
    await expect(chat()).rejects.toBeDefined();

    expect(connectTargets.includes('127.0.0.1:18080')).toBe(!ENABLE_BUSINESS_FEATURES);
  });

  it('never forwards a user baseURL into the platform-owned lobehub router', () => {
    const runtime = initModelRuntimeWithUserPayload(
      ModelProvider.LobeHub,
      { apiKey: 'user-key', baseURL: 'http://169.254.169.254/v1' },
      { userId: 'tenant-user' },
    );

    const options = (runtime['_runtime'] as any)._options;
    expect(options.baseURL).toBeUndefined();
    expect(options.fetch).toBeUndefined();
  });
});
