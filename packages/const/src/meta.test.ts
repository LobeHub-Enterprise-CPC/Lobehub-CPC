import type * as BusinessConstModule from '@lobechat/business-const';
import { afterEach, describe, expect, it, vi } from 'vitest';

const brand = vi.hoisted(() => ({ logo: '', userAvatar: '' }));

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof BusinessConstModule>()),
  get BRANDING_LOGO_URL() {
    return brand.logo;
  },
  get BRANDING_USER_AVATAR_URL() {
    return brand.userAvatar;
  },
}));

// The defaults are read from the brand slots when the module loads.
const loadMeta = async () => {
  vi.resetModules();
  return import('./meta');
};

describe('default user avatar', () => {
  afterEach(() => {
    brand.logo = '';
    brand.userAvatar = '';
  });

  it('keeps the upstream fallbacks when the distribution brands no user avatar', async () => {
    const meta = await loadMeta();

    expect(meta.BRANDED_USER_AVATAR).toBeUndefined();
    expect(meta.DEFAULT_USER_AVATAR).toBe('😀');
    expect(meta.DEFAULT_USER_AVATAR_URL).toBe('/app-icons/icon-192x192.png');
  });

  it('shows the branded avatar for a person without one, not the upstream emoji or logo', async () => {
    brand.logo = '/brand/logo.png';
    brand.userAvatar = '/brand/user-avatar.png';

    const meta = await loadMeta();

    expect(meta.BRANDED_USER_AVATAR).toBe('/brand/user-avatar.png');
    expect(meta.DEFAULT_USER_AVATAR).toBe('/brand/user-avatar.png');
    expect(meta.DEFAULT_USER_AVATAR_URL).toBe('/brand/user-avatar.png');
  });

  it('keeps the logo for signed-out surfaces when only the logo is branded', async () => {
    brand.logo = '/brand/logo.png';

    const meta = await loadMeta();

    expect(meta.DEFAULT_USER_AVATAR).toBe('😀');
    expect(meta.DEFAULT_USER_AVATAR_URL).toBe('/brand/logo.png');
  });
});
