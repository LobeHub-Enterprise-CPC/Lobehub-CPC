// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./libs/debug-file-logger', () => ({}));

const registerWith = async (env: Record<string, string>) => {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { register } = await import('./instrumentation');
  return register();
};

describe('instrumentation register', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses to start when the agent and device gateway service tokens are equal', async () => {
    await expect(
      registerWith({
        AGENT_GATEWAY_SERVICE_TOKEN: 'same',
        DEVICE_GATEWAY_SERVICE_TOKEN: 'same',
        NEXT_RUNTIME: 'nodejs',
      }),
    ).rejects.toThrow('DEVICE_GATEWAY_SERVICE_TOKEN');
  });

  it('starts with distinct tokens', async () => {
    await expect(
      registerWith({
        AGENT_GATEWAY_SERVICE_TOKEN: 'agent',
        DEVICE_GATEWAY_SERVICE_TOKEN: 'device',
        NEXT_RUNTIME: 'nodejs',
      }),
    ).resolves.toBeUndefined();
  });
});
