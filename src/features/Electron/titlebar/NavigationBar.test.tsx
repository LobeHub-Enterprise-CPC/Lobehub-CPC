import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NavigationBar from './NavigationBar';

const mocks = vi.hoisted(() => ({
  communityShowcase: false,
  isMac: false,
  handlers: new Map<string, () => void>(),
  leftPanelVisible: false,
  leftPanelWidth: 0,
  navigate: vi.fn(),
  navRailEnabled: false,
  openAllAgentsDrawer: vi.fn(),
  pathname: '/',
}));

vi.mock('@lobechat/business-const', () => ({
  get COMMUNITY_SHOWCASE_LAYOUT() {
    return mocks.communityShowcase;
  },
  get NAV_RAIL_ENABLED() {
    return mocks.navRailEnabled;
  },
}));
vi.mock('@/hooks/useActiveLocation', () => ({
  useActiveLocation: () => ({ pathname: mocks.pathname, search: '' }),
}));

vi.mock('@lobechat/electron-client-ipc', () => ({
  useWatchBroadcast: (event: string, handler: () => void) => mocks.handlers.set(event, handler),
}));

vi.mock('@lobehub/ui', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createStaticStyles: () => ({ clock: 'clock', root: 'root' }),
}));

vi.mock('@/features/NavPanel/ToggleLeftPanelButton', () => ({ default: () => null }));
vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => mocks.navigate,
}));
vi.mock('@/services/electron/system', () => ({ electronSystemService: {} }));
vi.mock('@/store/global', () => ({
  useGlobalStore: (selector: (state: unknown) => unknown) => selector({}),
}));
vi.mock('@/store/global/selectors', () => ({
  systemStatusSelectors: {
    leftPanelWidth: () => mocks.leftPanelWidth,
    showLeftPanel: () => mocks.leftPanelVisible,
  },
}));
vi.mock('@/store/home', () => ({
  getHomeStoreState: () => ({ openAllAgentsDrawer: mocks.openAllAgentsDrawer }),
}));
vi.mock('@/store/electron', () => ({
  useElectronStore: (selector: (state: unknown) => unknown) =>
    selector({ activeRecentScope: { slug: 'acme', type: 'workspace' } }),
}));
vi.mock('@/styles/electron', () => ({ electronStylish: { nodrag: 'nodrag' } }));
vi.mock('@/utils/platform', () => ({
  getPlatform: () => 'Linux',
  isMacOS: () => mocks.isMac,
}));
vi.mock('./WindowsAppMenu', () => ({ default: () => null }));
vi.mock('../navigation/useNavigationHistory', () => ({
  useNavigationHistory: () => ({
    canGoBack: false,
    canGoForward: false,
    goBack: vi.fn(),
    goForward: vi.fn(),
  }),
}));
vi.mock('./RecentlyViewed', () => ({ default: () => <div>recently-viewed</div> }));
vi.mock('./TrayMenu/useTrayMenuSync', () => ({ useTrayMenuSync: vi.fn() }));

describe('NavigationBar tray broadcasts', () => {
  beforeEach(() => {
    mocks.communityShowcase = false;
    mocks.handlers.clear();
    mocks.isMac = false;
    mocks.leftPanelVisible = false;
    mocks.leftPanelWidth = 0;
    mocks.navRailEnabled = false;
    mocks.pathname = '/';
    vi.clearAllMocks();
  });

  it('opens the existing Recently Viewed popover', () => {
    render(<NavigationBar />);

    act(() => mocks.handlers.get('openRecentlyViewed')?.());

    expect(screen.getByText('recently-viewed')).toBeInTheDocument();
  });

  it('opens the workspace agent browser without creating a topic', () => {
    render(<NavigationBar />);

    act(() => mocks.handlers.get('openAllAgents')?.());

    expect(mocks.navigate).toHaveBeenCalledWith('/acme', { escape: true });
    expect(mocks.openAllAgentsDrawer).toHaveBeenCalled();
  });

  it('keeps titlebar navigation width animatable when the sidebar is collapsed', () => {
    const { container, unmount } = render(<NavigationBar />);
    const navigationBar = container.querySelector('.root') as HTMLElement;

    expect(navigationBar).toHaveStyle({ width: '150px' });
    unmount();

    mocks.leftPanelVisible = true;
    mocks.leftPanelWidth = 280;
    const expanded = render(<NavigationBar />);

    expect(expanded.container.querySelector('.root')).toHaveStyle({ width: '268px' });
  });

  // The tabs follow this bar, so its width is where they start: the content area's
  // left edge. With the icon rail on, that edge sits a rail (56px) further right.
  it('spans the icon rail too when the sidebar is expanded', () => {
    mocks.navRailEnabled = true;
    mocks.leftPanelVisible = true;
    mocks.leftPanelWidth = 280;

    const { container } = render(<NavigationBar />);

    expect(container.querySelector('.root')).toHaveStyle({ width: '324px' });
  });

  it('leaves the collapsed width alone when the icon rail is on', () => {
    mocks.navRailEnabled = true;

    const { container } = render(<NavigationBar />);

    expect(container.querySelector('.root')).toHaveStyle({ width: '150px' });
  });

  // The scheduled-task workspace unmounts the panel even while the preference says
  // expanded, so there is no panel width to span.
  it('uses the collapsed width on a page that hides the sidebar', () => {
    mocks.navRailEnabled = true;
    mocks.leftPanelVisible = true;
    mocks.leftPanelWidth = 280;
    mocks.pathname = '/tasks';

    const { container } = render(<NavigationBar />);

    expect(container.querySelector('.root')).toHaveStyle({ width: '150px' });
  });

  it('follows the showcase market flag on the community page', () => {
    mocks.navRailEnabled = true;
    mocks.leftPanelVisible = true;
    mocks.leftPanelWidth = 280;
    mocks.pathname = '/community';

    const kept = render(<NavigationBar />);
    expect(kept.container.querySelector('.root')).toHaveStyle({ width: '324px' });
    kept.unmount();

    mocks.communityShowcase = true;
    const hidden = render(<NavigationBar />);
    expect(hidden.container.querySelector('.root')).toHaveStyle({ width: '150px' });
  });

  it('reserves the traffic light inset on macOS when the sidebar is collapsed', async () => {
    mocks.isMac = true;
    vi.resetModules();
    const { default: MacNavigationBar } = await import('./NavigationBar');

    const { container } = render(<MacNavigationBar />);

    expect(container.querySelector('.root')).toHaveStyle({ width: '184px' });
  });
});
