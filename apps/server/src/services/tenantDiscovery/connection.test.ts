// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[] }));

vi.mock('pg', async (original) => ({
  ...(await original<object>()),
  Pool: class {
    constructor(config: Record<string, unknown>) {
      state.configs.push(config);
    }
    on() {}
    async connect() {
      return { on() {}, query: async () => ({ rows: [] }), release() {}, removeListener() {} };
    }
  },
}));
vi.mock('./permissions', () => ({ verifyLookupIdentity: async () => undefined }));

afterEach(() => {
  vi.unstubAllEnvs();
  state.configs = [];
});

const load = async () => {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgres://platform@127.0.0.1:1/platform');
  vi.stubEnv('ACCOUNT_LOOKUP_DATABASE_URL', 'postgres://lookup@127.0.0.1:1/platform');
  const connection = await import('./connection');
  const signal = new AbortController().signal;
  await connection.withLookupClient(signal, async () => undefined);
  await connection.withDiscoveryPlatformClient(signal, async () => undefined);
  return state.configs;
};

describe('tenant discovery pools', () => {
  it('name their connections and keep the previous limits', async () => {
    expect(await load()).toEqual([
      expect.objectContaining({
        application_name: expect.stringMatching(/\/discovery-lookup(\/|$)/),
        max: 2,
      }),
      expect.objectContaining({
        application_name: expect.stringMatching(/\/discovery-platform(\/|$)/),
        max: 4,
      }),
    ]);
  });

  it('take their configured limits', async () => {
    vi.stubEnv('DB_DISCOVERY_LOOKUP_POOL_MAX', '3');
    vi.stubEnv('DB_DISCOVERY_PLATFORM_POOL_MAX', '5');
    expect((await load()).map((config) => config.max)).toEqual([3, 5]);
  });
});
