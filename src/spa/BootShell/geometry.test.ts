import type * as BusinessConst from '@lobechat/business-const';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useGlobalStore } from '@/store/global';
import { INITIAL_STATUS } from '@/store/global/initialState';

import { readBootShellGeometry } from './geometry';

const flags = vi.hoisted(() => ({ navRailEnabled: false }));

vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<typeof BusinessConst>()),
  get NAV_RAIL_ENABLED() {
    return flags.navRailEnabled;
  },
}));

const setStatus = (status: Partial<typeof INITIAL_STATUS>) =>
  useGlobalStore.setState({ status: { ...INITIAL_STATUS, ...status } });

beforeEach(() => {
  flags.navRailEnabled = false;
  window.history.replaceState({}, '', '/');
  setStatus({});
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
  delete document.documentElement.dataset.theme;
});

describe('readBootShellGeometry', () => {
  it('reads the panel layout from the store', () => {
    setStatus({ leftPanelWidth: 320, showLeftPanel: true });

    const geometry = readBootShellGeometry();

    expect(geometry.navPanelWidth).toBe(320);
    expect(geometry.showLeftPanel).toBe(true);
  });

  it('clamps the panel width to the draggable range', () => {
    setStatus({ leftPanelWidth: 9999 });
    expect(readBootShellGeometry().navPanelWidth).toBe(400);

    setStatus({ leftPanelWidth: 10 });
    expect(readBootShellGeometry().navPanelWidth).toBe(240);
  });

  it('falls back to the default width for an unusable persisted value', () => {
    setStatus({ leftPanelWidth: Number.NaN });

    expect(readBootShellGeometry().navPanelWidth).toBe(INITIAL_STATUS.leftPanelWidth);
  });

  // The app renders the rail left of the panel, open or collapsed. Without the same
  // width here, the content area jumps a rail to the right when the app takes over.
  it('reserves the icon rail width only when the rail is on', () => {
    expect(readBootShellGeometry().navRailWidth).toBe(0);

    flags.navRailEnabled = true;
    setStatus({ showLeftPanel: false });
    expect(readBootShellGeometry().navRailWidth).toBe(56);

    setStatus({ showLeftPanel: true });
    expect(readBootShellGeometry().navRailWidth).toBe(56);
  });

  it('draws no panel for a boot url whose page hides it', () => {
    setStatus({ showLeftPanel: true });
    window.history.replaceState({}, '', '/tasks');

    expect(readBootShellGeometry().showLeftPanel).toBe(false);
  });

  it('follows the theme already resolved onto the document', () => {
    expect(readBootShellGeometry().isDark).toBe(false);

    document.documentElement.dataset.theme = 'dark';
    expect(readBootShellGeometry().isDark).toBe(true);
  });
});
