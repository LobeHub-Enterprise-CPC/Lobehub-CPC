import type * as BusinessConst from '@lobechat/business-const';
import type { UpdaterState } from '@lobechat/electron-client-ipc';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Version from './Version';

const flags = { enableCheckUpdates: true, showChangelog: true };
const electron = { ipc: {} as unknown, updaterState: { stage: 'idle' } as UpdaterState };

// Partial mock so the rest of the branding surface stays real. Overriding only
// the one slot keeps both of its states testable whatever this build ships.
const branding = { changelogEnabled: true };

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof BusinessConst>()),
  get CHANGELOG_ENABLED() {
    return branding.changelogEnabled;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({ changelog: 'Changelog', checkForUpdates: 'Check for updates' })[key] || key,
  }),
}));

vi.mock('@lobechat/electron-client-ipc', () => ({
  getElectronIpc: () => electron.ipc,
  useWatchBroadcast: vi.fn(),
}));

vi.mock('@/services/electron/autoUpdate', () => ({
  autoUpdateService: {
    checkUpdate: vi.fn(),
    getBuildChannel: () => Promise.resolve('stable'),
    getUpdaterState: () => Promise.resolve(electron.updaterState),
    installNow: vi.fn(),
  },
}));

vi.mock('@/services/electron/rendererOta', () => ({
  rendererOtaService: { getStatus: vi.fn(async () => ({ current: null, running: null })) },
}));

vi.mock('@/components/Branding', () => ({ ProductLogo: () => <div /> }));
vi.mock('@/features/User/UserPanel/useNewVersion', () => ({ useNewVersion: () => false }));

vi.mock('@/store/global', () => ({
  useGlobalStore: (selector: (s: unknown) => unknown) =>
    selector({
      latestVersion: undefined,
      serverVersion: undefined,
      useCheckLatestVersion: () => ({ error: undefined, isValidating: false, mutate: vi.fn() }),
      useCheckServerVersion: () => undefined,
    }),
}));

vi.mock('@/store/serverConfig', () => ({
  featureFlagsSelectors: (s: unknown) => s,
  useServerConfigStore: (selector: (s: unknown) => unknown) =>
    selector({ ...flags, canAccessDevDock: false }),
}));

beforeEach(() => {
  branding.changelogEnabled = true;
  flags.enableCheckUpdates = true;
  flags.showChangelog = true;
  electron.ipc = {};
  electron.updaterState = { stage: 'idle' };
});

afterEach(() => {
  cleanup();
});

describe('About > Version', () => {
  it('hides the changelog link when the deployment turns the flag off', async () => {
    flags.showChangelog = false;

    render(<Version />);

    // CHANGELOG_URL points at the hosted site, so a rebranded or self-hosted
    // deployment was linking out to another product's release notes.
    expect(screen.queryByText('Changelog')).not.toBeInTheDocument();
  });

  it('hides the changelog link when the build ships no changelog', () => {
    branding.changelogEnabled = false;

    render(<Version />);

    // Distinct from the flag above, and the reason both exist: the flag comes
    // from server config, so it can only say "this deployment hides it today".
    // A build with no changelog of its own must not be able to show the link at
    // all, whatever config it is later handed.
    expect(screen.queryByText('Changelog')).not.toBeInTheDocument();
  });

  it('keeps the changelog link when both the build and the flag allow it', () => {
    render(<Version />);

    expect(screen.getByText('Changelog')).toBeInTheDocument();
  });

  it('offers no update button when the build ships no update feed', async () => {
    electron.updaterState = { stage: 'disabled' };

    render(<Version />);
    // The state arrives over IPC, so let the effect resolve.
    await vi.waitFor(() => expect(screen.queryByText('Check for updates')).not.toBeInTheDocument());
  });

  it('offers the update button on a build that has one', async () => {
    render(<Version />);

    await vi.waitFor(() => expect(screen.getByText('Check for updates')).toBeInTheDocument());
  });
});
