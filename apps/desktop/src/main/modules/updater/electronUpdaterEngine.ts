import log from 'electron-log';
import { autoUpdater } from 'electron-updater';

import { isDev } from '@/const/env';
import { getDesktopEnv } from '@/env';

import { UPDATE_SERVER_URL } from './configs';
import type { UpdateEngine } from './engine';

autoUpdater.autoInstallOnAppQuit = false;

export const electronUpdaterEngine: UpdateEngine = {
  checkForUpdates: () => autoUpdater.checkForUpdates(),
  configure: (channel) => {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.autoDownload = false;
    autoUpdater.forceDevUpdateConfig = isDev || getDesktopEnv().FORCE_DEV_UPDATE_CONFIG;
    autoUpdater.allowPrerelease = channel !== 'stable';
    if (!autoUpdater.forceDevUpdateConfig) {
      const baseUrl = UPDATE_SERVER_URL?.replace(/\/(stable|nightly|canary|beta)\/?$/, '').replace(
        /\/$/,
        '',
      );
      if (baseUrl) {
        autoUpdater.channel = channel;
        autoUpdater.setFeedURL({ provider: 'generic', url: `${baseUrl}/${channel}` });
      } else {
        // A packaged build must never fall back to the upstream repo: pointing a
        // distribution at it makes the app offer another product's releases as
        // its own updates, and reaches the network from installs that are meant
        // to be closed. A packaged build with no UPDATE_SERVER_URL is a
        // misconfiguration, so say so and leave the feed unset — electron-updater
        // then fails the check loudly instead of quietly updating off-brand.
        log.warn(
          'No UPDATE_SERVER_URL configured in a packaged build — update checks will fail. ' +
            'Set UPDATE_SERVER_URL to a release feed, or DESKTOP_DISABLE_UPDATES=1 to turn updates off.',
        );
      }
    }
    // The channel setter mutates this flag. Windows/Linux retain rollback support.
    autoUpdater.allowDowngrade = true;
  },
  downloadUpdate: () => autoUpdater.downloadUpdate(),
  installOnQuit: () => {
    autoUpdater.autoInstallOnAppQuit = true;
  },
  kind: 'electron-updater',
  on: (event, listener) => {
    autoUpdater.on(event, listener as (...args: any[]) => void);
  },
  quitAndInstall: () => autoUpdater.quitAndInstall(true, true),
};
