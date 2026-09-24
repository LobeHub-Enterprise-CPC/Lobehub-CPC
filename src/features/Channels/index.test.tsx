import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LAB_FEATURES } from '@/features/Settings/labs/features';

import ChannelList from './ChannelList';
import Channels from './index';

const { availability, page, swr, workspace } = vi.hoisted(() => ({
  availability: vi.fn(),
  page: vi.fn(),
  swr: vi.fn(),
  workspace: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router', () => ({
  Navigate: () => null,
  useParams: () => ({ channelId: 'channel' }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock('swr', () => ({ default: swr, useSWRConfig: () => ({ mutate: vi.fn() }) }));
vi.mock('@/services/channel', () => ({ channelService: { availability } }));
vi.mock('@/business/client/hooks/useActiveWorkspaceId', () => ({
  useActiveWorkspaceId: workspace,
}));
vi.mock('@/hooks/useActiveLocation', () => ({
  useActiveLocation: () => ({ pathname: '/', search: '' }),
}));
vi.mock('@/features/Workspace/useWorkspaceAwareNavigate', () => ({
  useWorkspaceAwareNavigate: () => vi.fn(),
}));
vi.mock('@/features/NavPanel/components/NavItem', () => ({ default: () => null }));
vi.mock('@/features/NavPanel/components/ThreadNavItem', () => ({ default: () => null }));
vi.mock('@/features/NavPanel/components/SkeletonList', () => ({ default: () => null }));
vi.mock('@/components/RenameModal', () => ({ openRenameModal: vi.fn() }));
vi.mock('./CreateChannel', () => ({ openCreateChannelModal: vi.fn() }));
// A persisted false flag must no longer gate the page.
vi.mock('@/store/user', () => ({ useUserStore: () => false }));
vi.mock('./useChannelPage', () => ({ useChannelPage: page }));
vi.mock('./ChannelConversation', () => ({ ChannelConversation: () => null }));
vi.mock('./ChannelHeader', () => ({ ChannelHeader: () => null }));
vi.mock('./ThreadPanel', () => ({ ThreadPanel: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  page.mockReturnValue({});
  workspace.mockReturnValue(undefined);
});
afterEach(cleanup);

describe('Channels outside Labs', () => {
  it('shows the sidebar create action without Labs opt-in', () => {
    swr.mockImplementation((key) => ({
      data: key === 'channel-availability' ? { enabled: true } : [],
    }));
    render(<ChannelList />);
    expect(screen.getByRole('button', { name: 'create' })).toBeTruthy();
    expect(swr).toHaveBeenCalledWith('channel-availability', availability);
  });

  it.each(['workspace', 'unavailable'])('hides the sidebar for %s', (state) => {
    workspace.mockReturnValue(state === 'workspace' ? 'workspace' : undefined);
    swr.mockReturnValue({ data: { enabled: state !== 'unavailable' } });
    const { container } = render(<ChannelList />);
    expect(container.innerHTML).toBe('');
  });

  it('loads the channel by default when the service is enabled', () => {
    swr.mockReturnValue({ data: { enabled: true } });
    render(<Channels />);
    expect(swr).toHaveBeenCalledWith('channel-availability', availability);
    expect(page).toHaveBeenCalledWith('channel', null, true);
    expect(screen.getByText('loading')).toBeTruthy();
    expect(screen.queryByText('unavailable')).toBeNull();
  });

  it('still blocks channel loading when the service is unavailable', () => {
    swr.mockReturnValue({ data: { enabled: false } });
    render(<Channels />);
    expect(page).toHaveBeenCalledWith('channel', null, false);
    expect(screen.getByText('unavailable')).toBeTruthy();
  });

  it('does not register a Channel Labs setting or search entry', () => {
    expect(LAB_FEATURES.some(({ flag }) => String(flag) === 'enableChannel')).toBe(false);
  });
});
