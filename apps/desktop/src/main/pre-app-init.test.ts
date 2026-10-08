import path from 'node:path';

import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/profiles'), setName: vi.fn(), setPath: vi.fn() },
}));

describe('distribution profile identity', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('ELECTRON_IS_DEV', '0');
    vi.stubEnv('DESKTOP_PRODUCT_NAME', 'NEW Product');
    vi.stubEnv('DESKTOP_APP_NAME', 'Original Product');
    vi.stubEnv('DESKTOP_USER_DATA_NAME', 'Existing Profile');
    vi.stubEnv('LOBE_DESKTOP_USER_DATA_DIR', '');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('preserves credential identity and profile directory when the display name changes', async () => {
    await import('./pre-app-init');

    expect(app.setName).toHaveBeenCalledWith('Original Product');
    expect(app.setPath).toHaveBeenCalledWith(
      'userData',
      path.join('/profiles', 'Existing Profile'),
    );
  });

  it('defaults to the product name when no stable profile name is configured', async () => {
    vi.stubEnv('DESKTOP_APP_NAME', '');
    vi.stubEnv('DESKTOP_USER_DATA_NAME', '');
    await import('./pre-app-init');

    expect(app.setName).toHaveBeenCalledWith('NEW Product');
    expect(app.setPath).toHaveBeenCalledWith('userData', path.join('/profiles', 'NEW Product'));
  });

  it('defaults the profile to the stable internal name, not the renamed display', async () => {
    vi.stubEnv('DESKTOP_USER_DATA_NAME', '');
    await import('./pre-app-init');

    expect(app.setName).toHaveBeenCalledWith('Original Product');
    expect(app.setPath).toHaveBeenCalledWith(
      'userData',
      path.join('/profiles', 'Original Product'),
    );
  });

  it('keeps development profiles independent of distribution branding', async () => {
    vi.stubEnv('ELECTRON_IS_DEV', '1');
    vi.stubEnv('LOBE_DESKTOP_USER_DATA_DIR', '/dev-instance');
    await import('./pre-app-init');

    expect(app.setName).toHaveBeenCalledWith('lobehub-desktop-dev');
    expect(app.setPath).toHaveBeenCalledExactlyOnceWith('userData', '/dev-instance');
  });
});
