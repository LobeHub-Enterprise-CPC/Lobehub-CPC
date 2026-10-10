import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('dotenv', () => ({ config: vi.fn() }));

describe('Drizzle migration targets', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DRIZZLE_TARGET', undefined);
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost/drizzle_config_test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the existing application migration chain as the default', async () => {
    const { default: config } = await import('../drizzle.config');

    expect(config.schema).toBe('./packages/database/src/schemas');
    expect(config.out).toBe('./packages/database/migrations');
  });

  it('pairs platform schemas with their own migration history and connection', async () => {
    vi.stubEnv('DRIZZLE_TARGET', 'platform');
    const { default: config } = await import('../drizzle.config');

    expect(config.schema).toBe('./packages/database/src/platform/schemas.ts');
    expect(config.out).toBe('./packages/database/migrations/platform');
    expect(config.dbCredentials).toEqual({ url: 'postgresql://localhost/drizzle_config_test' });
  });

  it('rejects an unknown target instead of writing to the default migration chain', async () => {
    vi.stubEnv('DRIZZLE_TARGET', 'platfrom');

    await expect(import('../drizzle.config')).rejects.toThrow('Unknown DRIZZLE_TARGET');
  });
});
