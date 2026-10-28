/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'https://app.example.com' } }));

const loadHeader = async (branding: { logo: string; name: string }) => {
  vi.resetModules();
  vi.doMock('@lobechat/business-const', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    BRANDING_LOGO_URL: branding.logo,
    BRANDING_NAME: branding.name,
  }));
  vi.doMock('@lobechat/const', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    isCustomBranding: branding.name !== 'LobeHub',
  }));

  const { getEmailBrandHeaderHtml } = await import('./brandHeader');
  return getEmailBrandHeaderHtml();
};

describe('getEmailBrandHeaderHtml', () => {
  afterEach(() => {
    vi.doUnmock('@lobechat/business-const');
    vi.doUnmock('@lobechat/const');
  });

  // Mail clients have no base URL, so a site-relative logo would render broken.
  it('joins a site-relative logo onto the app origin', async () => {
    const html = await loadHeader({ logo: '/branding/logo.png', name: 'Acme' });

    expect(html).toContain('src="https://app.example.com/branding/logo.png"');
    expect(html).toContain('Acme');
    expect(html).not.toContain('🤯');
  });

  it('keeps an absolute logo URL as configured', async () => {
    const html = await loadHeader({ logo: 'https://cdn.example.com/logo.png', name: 'Acme' });

    expect(html).toContain('src="https://cdn.example.com/logo.png"');
  });

  it('shows only the name for a rebranded deployment without a logo', async () => {
    const html = await loadHeader({ logo: '', name: 'Acme' });

    expect(html).not.toContain('<img');
    expect(html).not.toContain('🤯');
    expect(html).toContain('Acme');
  });

  it('keeps the upstream mark for the default brand', async () => {
    const html = await loadHeader({ logo: '', name: 'LobeHub' });

    expect(html).not.toContain('<img');
    expect(html).toContain('🤯');
  });
});
