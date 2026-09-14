import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CodexChannelStart } from '@lobechat/heterogeneous-agents/channel';
import { ChannelAgentClient } from '@lobechat/heterogeneous-agents/channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectHeterogeneousCliCommand } from '@/modules/binaries';

import { createChannelLaunch, createChannelProbe } from './channelLaunch';
import { getProviderBindingRuntime } from './providerBindingPort';

vi.mock('./providerBindingPort', () => ({
  getProviderBindingRuntime: vi.fn(),
  getServerDefaultEndpoint: async () => 'https://example.com',
}));
vi.mock('@/modules/binaries', () => ({ detectHeterogeneousCliCommand: vi.fn() }));
beforeEach(() => {
  vi.mocked(detectHeterogeneousCliCommand).mockResolvedValue({
    available: true,
    path: '/custom/agent',
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const auth = {
  getAccessToken: async () => 'desktop-token',
  getServerUrl: async () => 'https://example.com',
};
const input = (runtime: NonNullable<CodexChannelStart['runtime']>): CodexChannelStart => ({
  cwd: '/repo',
  ownerId: 'owner',
  fence: 1,
  runId: 'run',
  model: '',
  runtime,
  manifest: {} as never,
  provider: {
    type: runtime,
    command: '/custom/agent',
    authMode: 'api',
    apiConfig: { providerId: 'provider', model: 'gpt-test' },
    env: { CUSTOM: 'preserved' },
  },
});

describe('Channel Desktop provider binding parity', () => {
  it.each(['codex', 'grok-build'] as const)(
    '%s uses the ordinary private provider profile',
    async (runtime) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'channel-profile-'));
      try {
        vi.mocked(getProviderBindingRuntime).mockResolvedValue({
          enabled: true,
          enabledModels: [{ id: 'gpt-test', providerId: 'provider', type: 'chat' }],
          runtimeConfig: {
            config: { enableResponseApi: true },
            keyVaults: { apiKey: 'private-key', baseURL: 'https://example.com/v1' },
            settings: { sdkType: 'openai', supportResponsesApi: true },
          },
        });
        const launch = await createChannelLaunch(auth, root)(input(runtime));
        expect(launch.command).toBe('/custom/agent');
        expect(launch.bindingKey).toMatch(/^provider-binding:/);
        expect(launch.inheritEnv).toBe(false);
        expect(launch.env?.CUSTOM).toBe('preserved');
        const home = launch.env?.[runtime === 'codex' ? 'CODEX_HOME' : 'GROK_HOME'];
        expect(home).toBeTruthy();
        expect(await readFile(path.join(home!, 'config.toml'), 'utf8')).not.toContain(
          'private-key',
        );
        expect(Object.values(launch.env!)).toContain('private-key');
        expect(launch.extraArgs).not.toContain('--max-turns');
        await launch.cleanup?.();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(['claude-code', 'pi'] as const)(
    '%s uses its existing API binding and selected model',
    async (runtime) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'channel-profile-'));
      try {
        vi.mocked(getProviderBindingRuntime).mockResolvedValue({
          enabled: true,
          enabledModels: [{ id: 'gpt-test', providerId: 'provider', type: 'chat' }],
          runtimeConfig: {
            keyVaults: { apiKey: 'private-key', baseURL: 'https://example.com/v1' },
            settings: { sdkType: 'anthropic' },
          },
        });
        const request = input(runtime);
        request.model = 'stale-membership-model';
        const launch = await createChannelLaunch(auth, root)(request);
        expect(launch.command).toBe('/custom/agent');
        expect(launch.bindingKey).toMatch(/^provider-binding:/);
        expect(launch.inheritEnv).toBe(false);
        expect(launch.env?.CUSTOM).toBe('preserved');
        expect(launch.extraArgs).toContain('--model');
        expect(launch.extraArgs![launch.extraArgs!.indexOf('--model') + 1]).toBe('gpt-test');
        expect(launch.extraArgs).not.toContain('stale-membership-model');
        if (runtime === 'claude-code') {
          expect(launch.env?.ANTHROPIC_AUTH_TOKEN).toBe('private-key');
          expect(launch.env?.ANTHROPIC_BASE_URL).toBe('https://example.com');
          expect(launch.env).not.toHaveProperty('ANTHROPIC_API_KEY');
          expect(launch.env?.CLAUDE_CONFIG_DIR).toBeTruthy();
        } else {
          expect(launch.env?.LOBEHUB_PI_API_KEY).toBe('private-key');
          const models = await readFile(
            path.join(launch.env!.PI_CODING_AGENT_DIR, 'models.json'),
            'utf8',
          );
          expect(models).toContain('gpt-test');
          expect(models).toContain('anthropic-messages');
          expect(models).not.toContain('private-key');
        }
        await launch.cleanup?.();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('uses the detected shell PATH and Desktop proxy for both probe and subscription launch', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'host-only');
    const app = {
      binaryManager: {
        detect: vi.fn().mockResolvedValue({
          available: true,
          path: '/login/bin/amp',
          resolvedPathEnv: '/login/bin:/usr/bin',
        }),
      },
      storeManager: {
        get: () => ({
          enableProxy: true,
          proxyType: 'http',
          proxyServer: '127.0.0.1',
          proxyPort: 8123,
        }),
      },
    };
    const request = {
      ...input('codex'),
      runtime: 'amp' as const,
      provider: { type: 'amp' as const },
    };
    const launch = await createChannelLaunch(auth, '/unused', app as never)(request);
    expect(launch.command).toBe('/login/bin/amp');
    expect(launch.env).toMatchObject({
      PATH: '/login/bin:/usr/bin',
      HTTPS_PROXY: 'http://127.0.0.1:8123',
    });
    expect(launch.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    const probe = vi.spyOn(ChannelAgentClient, 'probe').mockResolvedValue('amp-version');
    await createChannelProbe(app as never)('/repo', 'amp', request.provider);
    expect(probe).toHaveBeenCalledWith(
      '/repo',
      'amp',
      expect.objectContaining({ command: launch.command, env: launch.env }),
      false,
    );
  });

  it('preserves binding identity across credential rotation but not endpoint/model changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-identity-'));
    vi.stubEnv('XAI_API_KEY', 'inherited-current');
    vi.stubEnv('GROK_CODE_XAI_API_KEY', 'inherited-legacy');
    try {
      const runtime = (apiKey: string, baseURL: string) => ({
        enabled: true,
        enabledModels: [
          { id: 'gpt-test', providerId: 'provider', type: 'chat' as const },
          { id: 'other', providerId: 'provider', type: 'chat' as const },
        ],
        runtimeConfig: {
          config: { enableResponseApi: true },
          keyVaults: { apiKey, baseURL },
          settings: { sdkType: 'openai' as const, supportResponsesApi: true },
        },
      });
      const prepare = createChannelLaunch(auth, root);
      vi.mocked(getProviderBindingRuntime).mockResolvedValue(
        runtime('key-1', 'https://example.com/v1'),
      );
      const first = await prepare(input('grok-build'));
      expect(first.env).not.toHaveProperty('XAI_API_KEY');
      expect(first.env).not.toHaveProperty('GROK_CODE_XAI_API_KEY');
      await first.cleanup?.();
      vi.mocked(getProviderBindingRuntime).mockResolvedValue(
        runtime('key-2', 'https://example.com/v1'),
      );
      const rotated = await prepare(input('grok-build'));
      expect(rotated.bindingKey).toBe(first.bindingKey);
      await rotated.cleanup?.();
      vi.mocked(getProviderBindingRuntime).mockResolvedValue(
        runtime('key-2', 'https://other.example.com/v1'),
      );
      const changed = await prepare(input('grok-build'));
      expect(changed.bindingKey).not.toBe(first.bindingKey);
      await changed.cleanup?.();
      const request = input('grok-build');
      request.provider!.apiConfig!.model = 'other';
      const modelChanged = await prepare(request);
      expect(modelChanged.bindingKey).not.toBe(changed.bindingKey);
      await modelChanged.cleanup?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      runtime: 'codex',
      tokenEnv: 'LOBEHUB_HETERO_TOKEN',
      homeEnv: 'CODEX_HOME',
      file: 'config.toml',
    },
    {
      runtime: 'claude-code',
      tokenEnv: 'ANTHROPIC_AUTH_TOKEN',
      homeEnv: 'CLAUDE_CONFIG_DIR',
      file: null,
    },
    {
      runtime: 'pi',
      tokenEnv: 'LOBEHUB_PI_API_KEY',
      homeEnv: 'PI_CODING_AGENT_DIR',
      file: 'models.json',
    },
  ] as const)(
    '$runtime uses only the scoped operation credential for server-default and refuses missing authority',
    async ({ runtime, tokenEnv, homeEnv, file }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'channel-default-'));
      try {
        const request = input(runtime);
        request.provider!.apiConfig = { source: 'server-default', model: 'deepseek-v4-flash' };
        const prepare = createChannelLaunch(auth, root);
        await expect(prepare(request)).rejects.toThrow('authorization is missing');
        request.serverDefaultBinding = { model: 'lobehub-default', token: 'scoped-token' };
        const launch = await prepare(request);
        expect(launch.env?.[tokenEnv]).toBe('scoped-token');
        expect(launch.env?.[homeEnv]).toBeTruthy();
        if (file)
          expect(await readFile(path.join(launch.env![homeEnv], file), 'utf8')).not.toContain(
            'scoped-token',
          );
        expect(launch.extraArgs?.join(' ')).not.toContain('scoped-token');
        await launch.cleanup?.();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
