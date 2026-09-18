import { afterEach, describe, expect, it, vi } from 'vitest';

const loadManifest = async (branding: { name: string; pwaId: string }) => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.doMock('@lobechat/business-const', () => ({
    BRANDING_LOGO_URL: '/branding/logo.png',
    BRANDING_NAME: branding.name,
    BRANDING_PWA_ID: branding.pwaId,
  }));

  const { default: manifest } = await import('./manifest');

  return manifest();
};

describe('production PWA manifest identity', () => {
  afterEach(() => {
    vi.doUnmock('@lobechat/business-const');
    vi.unstubAllEnvs();
  });

  it('keeps the stable PWA id independent of a renamed display name', async () => {
    const result = await loadManifest({ name: 'Renamed Product', pwaId: 'original-product' });

    expect(result).toMatchObject({
      id: 'original-product',
      name: 'Renamed Product',
      scope: '/',
      short_name: 'Renamed Product',
      start_url: '/',
    });
  });

  it('derives the default id from the display name when no override is set', async () => {
    const result = await loadManifest({ name: 'Example Brand', pwaId: '' });

    expect(result.id).toBe('example-brand');
  });
});
