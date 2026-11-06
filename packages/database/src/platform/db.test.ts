// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const configs = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('pg', async (original) => ({
  ...(await original<object>()),
  Pool: class {
    constructor(config: Record<string, unknown>) {
      configs.push(config);
    }
    on() {}
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  configs.length = 0;
});

const load = async () => {
  vi.resetModules();
  vi.stubEnv('DATABASE_URL', 'postgres://platform@127.0.0.1:1/platform');
  const { getPlatformDB } = await import('./db');
  getPlatformDB();
  return configs;
};

describe('platform pool', () => {
  it('names its connections and keeps pg default max', async () => {
    vi.stubEnv('DB_PLATFORM_POOL_MAX', undefined);
    expect(await load()).toEqual([
      expect.objectContaining({
        application_name: expect.stringMatching(/^tw-[\w.-]+\/[\w.-]+\/\d+\/platform(\/|$)/),
        connectionString: 'postgres://platform@127.0.0.1:1/platform',
        max: 10,
      }),
    ]);
  });

  it('takes DB_PLATFORM_POOL_MAX', async () => {
    vi.stubEnv('DB_PLATFORM_POOL_MAX', '6');
    expect((await load())[0]).toMatchObject({ max: 6 });
  });
});
