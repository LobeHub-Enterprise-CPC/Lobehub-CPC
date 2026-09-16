import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentService } from '@/services/agent';
import { channelService } from '@/services/channel';
import { deviceService } from '@/services/device';

import { openCreateChannelModal } from './CreateChannel';
import {
  ChannelReadinessError,
  resolveChannelCandidates,
  resolveChannelSelections,
} from './resolveMembers';

const modal = vi.hoisted(() => ({
  close: vi.fn(),
  createAgent: vi.fn(),
  setCanDismissByClickOutside: vi.fn(),
}));

vi.mock('@lobehub/ui/base-ui', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createModal: (props: { content: ReactNode }) => props,
  useModalContext: () => ({
    close: modal.close,
    setCanDismissByClickOutside: modal.setCanDismissByClickOutside,
  }),
}));
// jsdom has no layout, so the virtual list would render nothing; render every row instead.
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({
    itemContent,
    totalCount,
  }: {
    itemContent: (index: number) => ReactNode;
    totalCount: number;
  }) => <div>{Array.from({ length: totalCount }, (_, index) => itemContent(index))}</div>,
}));
vi.mock('@/features/HomeSidebar/hooks', () => ({
  useCreateMenuItems: () => ({ createAgent: modal.createAgent }),
}));
vi.mock('@/services/agent', () => ({ agentService: { queryAgents: vi.fn() } }));
vi.mock('@/services/channel', () => ({
  channelService: { addMembers: vi.fn(), create: vi.fn() },
}));
vi.mock('@/services/device', () => ({ deviceService: { listDevices: vi.fn() } }));
vi.mock('./resolveMembers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveChannelCandidates: vi.fn(),
  resolveChannelSelections: vi.fn(),
}));

type Listed = Awaited<ReturnType<typeof agentService.queryAgents>>[number];
const listed = (id: string, extra?: Partial<Listed>) =>
  ({
    avatar: null,
    backgroundColor: null,
    description: null,
    id,
    name: null,
    title: id,
    ...extra,
  }) as Listed;
type Candidates = Awaited<ReturnType<typeof resolveChannelCandidates>>;

function renderCreate(props?: Parameters<typeof openCreateChannelModal>[0]) {
  const { content } = openCreateChannelModal(props) as unknown as { content: ReactNode };
  return render(
    <SWRConfig
      value={{
        dedupingInterval: 0,
        provider: () => new Map(),
        revalidateOnFocus: false,
        shouldRetryOnError: false,
      }}
    >
      {content}
    </SWRConfig>,
  );
}
const submitButton = () => screen.getByRole('button', { name: 'submit' });
const toggle = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }));

describe('CreateChannel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(deviceService.listDevices).mockResolvedValue([
      { deviceId: 'mac', online: false },
    ] as Awaited<ReturnType<typeof deviceService.listDevices>>);
    vi.mocked(resolveChannelCandidates).mockImplementation(
      async (ids) =>
        ({
          candidates: ids.map((agentId) => ({
            agentId,
            heterogeneous: agentId === 'codex',
            issue: agentId === 'codex' ? 'offline' : undefined,
            name: agentId,
          })),
          devices: [],
        }) as Candidates,
    );
  });

  it('labels blocked rows before submit and explains why the button stays disabled', async () => {
    vi.mocked(agentService.queryAgents).mockResolvedValue([
      listed('writer'),
      listed('reviewer'),
      listed('codex', { boundDeviceId: 'mac', heteroType: 'codex' }),
      listed('legacy', { heteroType: 'cursor' }),
    ]);
    renderCreate();

    // The rule is visible up front, and the primary action carries no counter.
    expect(await screen.findByText('membersHint')).toBeInTheDocument();
    expect(submitButton()).toHaveTextContent(/^submit$/);
    expect(submitButton()).toBeDisabled();
    // Cheap checks from the list payload alone: unsupported runtime and offline bound device.
    expect(await screen.findByText('unsupportedAgent')).toBeInTheDocument();
    expect(await screen.findByText('readiness.offline')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'legacy' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    fireEvent.change(screen.getByPlaceholderText('namePlaceholder'), {
      target: { value: '  product review  ' },
    });
    toggle('writer');
    toggle('codex');
    await waitFor(() => expect(screen.getByText('readiness.blocked')).toBeInTheDocument());
    expect(submitButton()).toBeDisabled();
    expect(modal.setCanDismissByClickOutside).toHaveBeenLastCalledWith(false);

    // Swap the offline device Agent for a ready one and the hint returns to the rule.
    toggle('codex');
    toggle('reviewer');
    await waitFor(() => expect(submitButton()).toBeEnabled());
    expect(screen.getByText('membersHint')).toBeInTheDocument();

    vi.mocked(resolveChannelSelections).mockResolvedValue([
      { agentId: 'writer' },
      { agentId: 'reviewer' },
    ]);
    vi.mocked(channelService.create).mockResolvedValue({ id: 'c1' } as Awaited<
      ReturnType<typeof channelService.create>
    >);
    fireEvent.click(submitButton());
    await waitFor(() => expect(modal.close).toHaveBeenCalled());
    expect(channelService.create).toHaveBeenCalledWith({
      members: [{ agentId: 'writer' }, { agentId: 'reviewer' }],
      title: 'product review',
    });
  });

  it('offers to create or connect an Agent when fewer than two can join', async () => {
    vi.mocked(agentService.queryAgents).mockResolvedValue([
      listed('writer'),
      listed('legacy', { heteroType: 'cursor' }),
    ]);
    renderCreate();

    expect(await screen.findByText('needMoreAgents')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'createAgent' }));
    expect(modal.close).toHaveBeenCalled();
    expect(modal.createAgent).toHaveBeenCalled();
  });

  it('shows readiness failures verbatim and wraps server failures in localized copy', async () => {
    vi.mocked(agentService.queryAgents).mockResolvedValue([listed('writer'), listed('reviewer')]);
    renderCreate();
    fireEvent.change(await screen.findByPlaceholderText('namePlaceholder'), {
      target: { value: 'review' },
    });
    toggle('writer');
    toggle('reviewer');
    await waitFor(() => expect(submitButton()).toBeEnabled());

    vi.mocked(resolveChannelSelections).mockRejectedValue(
      new ChannelReadinessError('writer, reviewer are not ready', []),
    );
    fireEvent.click(submitButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('writer, reviewer are not ready');

    // Changing the selection clears the stale error.
    toggle('reviewer');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    toggle('reviewer');
    await waitFor(() => expect(submitButton()).toBeEnabled());

    vi.mocked(resolveChannelSelections).mockResolvedValue([
      { agentId: 'writer' },
      { agentId: 'reviewer' },
    ]);
    vi.mocked(channelService.create).mockRejectedValue(
      new Error('Configure a model in this Agent before joining a Channel'),
    );
    fireEvent.click(submitButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('createFailed');
    expect(alert).toHaveTextContent('Configure a model in this Agent before joining a Channel');
    expect(modal.close).not.toHaveBeenCalled();
  });
});
