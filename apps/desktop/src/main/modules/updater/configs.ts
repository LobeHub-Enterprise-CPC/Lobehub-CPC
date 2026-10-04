import type { UpdateChannel } from '@lobechat/electron-client-ipc';

import { isDev } from '@/const/env';
import { getDesktopEnv } from '@/env';

// Build-time default channel, can be overridden at runtime via store
const rawChannel = getDesktopEnv().UPDATE_CHANNEL || 'stable';
export const coerceStoredUpdateChannel = (channel?: string | null): UpdateChannel =>
  channel === 'canary' ? 'canary' : 'stable';

/** Raw build channel for display (stable, canary, beta, or legacy nightly). */
export const BUILD_CHANNEL: string = rawChannel;
export const UPDATE_CHANNEL: UpdateChannel =
  rawChannel === 'canary' || rawChannel === 'beta' ? 'canary' : 'stable';

// S3 base URL for all channels
// e.g., https://releases.lobehub.com
// Each channel resolves to {base}/{channel}/
export const UPDATE_SERVER_URL = getDesktopEnv().UPDATE_SERVER_URL;

export const updaterConfig = {
  app: {
    autoCheckUpdate: true,
    autoDownloadUpdate: true,
    checkUpdateInterval: 60 * 60 * 1000, // 1 hour
  },
  /**
   * `DESKTOP_DISABLE_UPDATES` is the same switch `electron-builder.mjs` reads to
   * drop the publish config. It has to be honoured here as well: without a
   * publish config the packaged app simply has no `app-update.yml`, which the
   * updater then papers over by calling `setFeedURL` with the upstream GitHub
   * repo — so the build that was meant to have updates off ends up polling
   * somebody else's releases every hour instead.
   */
  enableAppUpdate: !isDev && !getDesktopEnv().DESKTOP_DISABLE_UPDATES,
};

export const getSparkleFeedUrl = (baseUrl: string, channel: UpdateChannel) =>
  `${baseUrl.replace(/\/(stable|nightly|canary|beta)\/?$/, '').replace(/\/$/, '')}/${channel}/appcast-${process.arch}.xml`;
