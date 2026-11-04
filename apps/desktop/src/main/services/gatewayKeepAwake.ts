import { powerSaveBlocker } from 'electron';

import { createLogger } from '@/utils/logger';

const logger = createLogger('services:GatewayKeepAwake');

interface KeepAwakeStore {
  get: (key: 'gatewayKeepAwake', fallback: boolean) => boolean;
  set: (key: 'gatewayKeepAwake', value: boolean) => void;
}

/**
 * Keeps the machine from idle-sleeping while the device is meant to be online,
 * as long as the person has not opted out (`gatewayKeepAwake`).
 */
export class GatewayKeepAwake {
  private blockerId: number | null = null;

  constructor(private readonly store: () => KeepAwakeStore) {}

  isEnabled(): boolean {
    return this.store().get('gatewayKeepAwake', true);
  }

  setEnabled(enabled: boolean, meantOnline: boolean) {
    this.store().set('gatewayKeepAwake', enabled);
    logger.info(`Keep awake while connected: ${enabled}`);
    this.sync(meantOnline);
  }

  /**
   * Hold the blocker for as long as the device is meant to be online — not
   * just while the socket is `connected`. Releasing it on every transient drop
   * (the socket blips every few tens of minutes) hands macOS a window to idle
   * sleep: with the default "sleep 1 minute after the display turns off" the
   * idle timer has long expired, so the machine sleeps before the ~2s reconnect
   * lands and stays offline until the user comes back. Only an explicit
   * disconnect (status settles on `disconnected`) or the user opting out lets
   * the system sleep again.
   */
  sync(meantOnline: boolean) {
    if (meantOnline && this.isEnabled()) this.start();
    else this.stop();
  }

  /**
   * 'prevent-app-suspension' keeps the system from idle-sleeping (and App Nap
   * from suspending the process) while still letting the display sleep.
   */
  private start() {
    if (this.blockerId !== null) return;
    this.blockerId = powerSaveBlocker.start('prevent-app-suspension');
    logger.info(`Power save blocker started (id=${this.blockerId})`);
  }

  private stop() {
    if (this.blockerId === null) return;
    powerSaveBlocker.stop(this.blockerId);
    logger.info(`Power save blocker stopped (id=${this.blockerId})`);
    this.blockerId = null;
  }
}
