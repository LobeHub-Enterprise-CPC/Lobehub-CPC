// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getAuthConfig', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should expose additional trusted origins', async () => {
    vi.stubEnv('AUTH_ADDITIONAL_TRUSTED_ORIGINS', 'https://gateway.example.com');

    const { getAuthConfig } = await import('../auth');

    expect(getAuthConfig().AUTH_ADDITIONAL_TRUSTED_ORIGINS).toBe('https://gateway.example.com');
  });
});
