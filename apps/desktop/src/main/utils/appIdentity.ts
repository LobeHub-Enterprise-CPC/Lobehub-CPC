import { app } from 'electron';

/** Display branding must not rename Electron's persistent credential identity. */
export const getAppDisplayName = (): string =>
  process.env.DESKTOP_PRODUCT_NAME?.trim() || app.getName();
