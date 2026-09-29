import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('@lobechat/business-const');
  vi.resetModules();
});

describe('LobeHubManifest branding', () => {
  it('uses the embedded brand icon rather than the static logo URL', async () => {
    vi.doMock('@lobechat/business-const', () => ({
      BRANDING_ICON_URL: 'data:image/svg+xml,%3Csvg%2F%3E',
      BRANDING_LOGO_URL: '/branding/logo.png',
      BRANDING_NAME: 'Acme Workspace',
    }));
    const { LobeHubManifest } = await import('./manifest');

    expect(LobeHubManifest.avatar).toBe('data:image/svg+xml,%3Csvg%2F%3E');
    expect(LobeHubManifest.identifier).toBe('lobehub');
    expect(LobeHubManifest.name).toBe('Acme Workspace');
    expect(LobeHubManifest.description).toContain('Manage the Acme Workspace platform');
  });

  it.each([undefined, ''])('keeps the embedded upstream icon for %s', async (icon) => {
    vi.doMock('@lobechat/business-const', () => ({
      BRANDING_ICON_URL: icon,
      BRANDING_LOGO_URL: '',
      BRANDING_NAME: 'LobeHub',
    }));
    const { LobeHubManifest } = await import('./manifest');

    expect(LobeHubManifest.avatar).toMatch(/^data:image\/x-icon;base64,/);
  });
});
