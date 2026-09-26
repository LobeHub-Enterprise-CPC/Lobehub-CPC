// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@lobechat/business-const', () => ({
  BRANDING_NAME: 'Private Workspace',
  OFFICIAL_URL: 'https://private.example',
}));
afterEach(() => vi.unstubAllEnvs());
it('uses the configured private origin in canonical metadata', async () => {
  vi.resetModules();
  vi.stubEnv('APP_URL', 'https://deployment.example');
  const { getCanonicalUrl } = await import('./url');
  expect(getCanonicalUrl('/agent/test')).toBe('https://deployment.example/agent/test');
  expect(getCanonicalUrl('https://images.example/logo.png')).toBe(
    'https://images.example/logo.png',
  );
});
it('falls back to the private business URL rather than the upstream domain', async () => {
  vi.resetModules();
  vi.stubEnv('APP_URL', '');
  const { getCanonicalUrl } = await import('./url');
  expect(getCanonicalUrl('/')).toBe('https://private.example/');
});
