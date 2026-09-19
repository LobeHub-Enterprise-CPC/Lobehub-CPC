import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { channelService } from '@/services/channel';

import { ChannelConversation } from './ChannelConversation';
import { buildChannelReceipts, type ChannelDetail } from './receipts';
import type { ChannelPagination } from './useChannelPage';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useUserAvatar', () => ({ useUserAvatar: () => '' }));
vi.mock('@/store/user', () => ({ useUserStore: () => 'You' }));
vi.mock('@/store/user/selectors', () => ({ userProfileSelectors: {} }));
vi.mock('@/services/channel', () => ({ channelService: { retryRouting: vi.fn() } }));
vi.mock('@/features/Conversation/store', () => ({
  createStore: vi.fn(),
  Provider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/features/Conversation/ChatItem', () => ({
  ChatItem: ({ belowMessage }: { belowMessage: ReactNode }) => <div>{belowMessage}</div>,
}));
vi.mock('@/features/Conversation/Markdown', () => ({ default: () => null }));
vi.mock('@/components/CollapsibleContent', () => ({ default: () => null }));
vi.mock('@/features/Portal/Thread/Chat/ThreadDivider', () => ({ default: () => null }));
vi.mock('@/features/WideScreenContainer', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('./Composer', () => ({
  Composer: ({ replying }: { replying: boolean }) => (
    <textarea aria-label="Composer" data-replying={replying} />
  ),
}));
vi.mock('./MessageAttachments', () => ({ MessageAttachments: () => null }));

const fixture = (threadId: string | null = null) =>
  ({
    channel: { id: 'channel', archived: false },
    approvals: [],
    attachments: [],
    contextMessages: [],
    discussions: [],
    members: [{ id: 'amp', name: 'Amp', active: true, config: {} }],
    messages: [
      { id: 'request', threadId, authorMemberId: null, sequence: 1, routingStatus: 'assigned' },
    ],
    jobs: [{ id: 'job', memberId: 'amp', messageId: 'request', threadId, status: 'running' }],
    runs: [{ jobId: 'job', status: 'running', activity: 'typing' }],
    threads: threadId ? [{ id: threadId, followerMemberIds: ['amp'] }] : [],
    replyCounts: [],
  }) as unknown as ChannelDetail;

const renderConversation = (data: ChannelDetail, threadId: string | null = null) =>
  render(
    <ChannelConversation
      data={data}
      pagination={{ pageKey: 'latest' } as ChannelPagination}
      receipts={buildChannelReceipts(data)}
      threadId={threadId}
      onRefresh={vi.fn()}
    />,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Channel conversation status', () => {
  it.each([null, 'thread'])('does not duplicate member activity in %s', (threadId) => {
    const { container } = renderConversation(fixture(threadId), threadId);

    expect(container.querySelector('[data-channel-activity]')).toBeNull();
    expect(screen.queryByText('Amp · activity.typing')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Composer' })).toBeTruthy();
  });

  it('does not reserve a status row when idle', () => {
    const data = fixture();
    data.jobs = [];
    data.runs = [];
    const { container } = renderConversation(data);

    expect(container.querySelector('[data-channel-activity]')).toBeNull();
  });

  it('preserves discussion progress without adding member activity', () => {
    const data = fixture();
    data.discussions = [
      { requestMessageId: 'request', status: 'active', round: 2, maxRounds: 5 },
    ] as ChannelDetail['discussions'];
    renderConversation(data);

    expect(screen.getByRole('status').textContent).toBe('discussion.active');
  });

  it('preserves the no-followers notice for a thread without active work', () => {
    const data = fixture('thread');
    data.jobs = [];
    data.runs = [];
    data.threads[0].followerMemberIds = [];
    renderConversation(data, 'thread');

    expect(screen.getByRole('status').textContent).toBe('threadNoFollowers');
  });

  it.each([true, false])('preserves undelivered notices with active members: %s', (active) => {
    const data = fixture();
    data.jobs = [];
    data.runs = [];
    data.members[0].active = active;
    data.messages[0].routingStatus = 'unassigned';
    renderConversation(data);

    expect(screen.getByRole('status').textContent).toContain(
      active ? 'activity.undelivered' : 'activity.noMembers',
    );
  });

  it.each([
    ['pending', 'receipt.assigning'],
    ['skipped', 'receipt.noReply'],
    ['unassigned', 'receipt.unassigned'],
  ] as const)('shows the distinct %s routing outcome', (routingStatus, label) => {
    const data = fixture();
    data.jobs = [];
    data.runs = [];
    data.messages[0].routingStatus = routingStatus;
    renderConversation(data);
    expect(screen.getByText(label)).toBeTruthy();
    expect(Boolean(screen.queryByRole('button', { name: 'retryRouting' }))).toBe(
      routingStatus === 'unassigned',
    );
    expect(screen.getByRole('textbox', { name: 'Composer' })).toHaveAttribute(
      'data-replying',
      String(routingStatus === 'pending'),
    );
    if (routingStatus === 'skipped') expect(screen.queryByText('activity.undelivered')).toBeNull();
  });

  it('retries the saved request without resending or allowing duplicate clicks', async () => {
    const data = fixture();
    data.jobs = [];
    data.runs = [];
    data.messages[0].routingStatus = 'unassigned';
    let finish!: () => void;
    vi.mocked(channelService.retryRouting).mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve(undefined);
      }),
    );
    renderConversation(data);
    const button = screen.getByRole('button', { name: 'retryRouting' });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(channelService.retryRouting).toHaveBeenCalledOnce();
    expect(channelService.retryRouting).toHaveBeenCalledWith('channel', 'request');
    await act(async () => finish());
    expect(button).not.toBeDisabled();
  });
});
