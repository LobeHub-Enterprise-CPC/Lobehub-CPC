import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AppShellSkeleton from './AppShellSkeleton';

const mocks = vi.hoisted(() => ({
  navRailEnabled: false,
  showLeftPanel: true,
}));

vi.mock('@lobechat/business-const', () => ({
  get NAV_RAIL_ENABLED() {
    return mocks.navRailEnabled;
  },
}));
vi.mock('@/components/Branding/ProductLogo', () => ({ ProductLogo: () => null }));
vi.mock('@/components/Skeleton/skeletonHandover', () => ({ retainSkeleton: () => {} }));
vi.mock('@/const/version', () => ({ isDesktop: true }));
vi.mock('@/features/DesktopLayoutContainer/cssVariables', () => ({
  getInnerCssVariables: () => ({}),
  getOuterCssVariables: () => ({}),
}));
vi.mock('@/features/DesktopLayoutContainer/style', () => ({ styles: {} }));
vi.mock('@/styles/electron', () => ({ electronStylish: { draggable: 'draggable' } }));
vi.mock('./geometry', () => ({
  readBootShellGeometry: () => ({
    isDark: false,
    navPanelBackground: 'transparent',
    navPanelWidth: 280,
    showLeftPanel: mocks.showLeftPanel,
  }),
}));

const railPlaceholder = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-boot-shell="nav-rail"]');

describe('AppShellSkeleton', () => {
  beforeEach(() => {
    mocks.navRailEnabled = false;
    mocks.showLeftPanel = true;
  });

  it('reserves no rail when the icon rail is off', () => {
    const { container } = render(<AppShellSkeleton />);

    expect(railPlaceholder(container)).toBeNull();
  });

  // The app renders the rail left of the panel, open or collapsed. Without the same
  // width here, the content area jumps a rail to the right when the app takes over.
  it.each([true, false])('reserves the icon rail width (panel open: %s)', (showLeftPanel) => {
    mocks.navRailEnabled = true;
    mocks.showLeftPanel = showLeftPanel;

    const { container } = render(<AppShellSkeleton />);

    expect(railPlaceholder(container)).toHaveStyle({ width: '56px' });
  });
});
