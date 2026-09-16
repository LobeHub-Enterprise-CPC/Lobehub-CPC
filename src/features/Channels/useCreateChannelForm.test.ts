import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { createElement } from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agentService } from '@/services/agent';
import { channelService } from '@/services/channel';
import { deviceService } from '@/services/device';

import {
  ChannelReadinessError,
  resolveChannelCandidates,
  resolveChannelSelections,
} from './resolveMembers';
import { useCreateChannelForm } from './useCreateChannelForm';

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

function wrapper() {
  const cache = new Map();
  return function SWRTestWrapper({ children }: PropsWithChildren) {
    return createElement(
      SWRConfig,
      {
        value: {
          provider: () => cache,
          dedupingInterval: 0,
          revalidateOnFocus: false,
          shouldRetryOnError: false,
        },
      },
      children,
    );
  };
}

type Listed = Awaited<ReturnType<typeof agentService.queryAgents>>[number];
type Candidates = Awaited<ReturnType<typeof resolveChannelCandidates>>;
type Devices = Awaited<ReturnType<typeof deviceService.listDevices>>;
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

function renderForm() {
  const onCreated = vi.fn();
  const onDone = vi.fn();
  const hook = renderHook(() => useCreateChannelForm({ onCreated, onDone }), {
    wrapper: wrapper(),
  });
  return { ...hook, onCreated, onDone };
}
const rowsOf = (result: { current: ReturnType<typeof useCreateChannelForm> }) =>
  Object.fromEntries(result.current.rows.map((row) => [row.id, row.status]));

describe('useCreateChannelForm', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(deviceService.listDevices).mockResolvedValue([
      { deviceId: 'mac', online: false },
    ] as Devices);
    vi.mocked(resolveChannelCandidates).mockImplementation(
      async (ids) =>
        ({
          candidates: ids.map((agentId) => ({
            agentId,
            deviceId: agentId === 'codex' ? 'mac' : undefined,
            heterogeneous: agentId === 'codex',
            heteroType: agentId === 'codex' ? 'codex' : undefined,
            issue: agentId === 'codex' ? 'offline' : undefined,
            name: agentId,
            workingDirectory: agentId === 'codex' ? '/work' : undefined,
          })),
          devices: [],
        }) as Candidates,
    );
    vi.mocked(channelService.create).mockResolvedValue({ id: 'c1' } as Awaited<
      ReturnType<typeof channelService.create>
    >);
  });

  it('labels blocked rows before submit and names the rule a submit attempt tripped', async () => {
    vi.mocked(agentService.queryAgents).mockResolvedValue([
      listed('writer'),
      listed('reviewer'),
      listed('codex', { boundDeviceId: 'mac', heteroType: 'codex' }),
      listed('legacy', { heteroType: 'cursor' }),
    ]);
    const { result, onCreated, onDone } = renderForm();
    await waitFor(() => expect(result.current.rows).toHaveLength(4));
    // Cheap checks from the list payload alone: unsupported runtime and offline bound device.
    await waitFor(() =>
      expect(rowsOf(result)).toEqual({
        codex: 'readiness.offline',
        legacy: 'unsupportedAgent',
        reviewer: undefined,
        writer: undefined,
      }),
    );
    expect(result.current.rows.find((row) => row.id === 'legacy')?.disabled).toBe(true);
    expect(result.current.memberHint).toBe('membersHint');
    expect(result.current.needMoreAgents).toBe(false);

    // An empty name is reported rather than silently disabling the button.
    expect(await act(() => result.current.submit())).toBe('title');
    expect(result.current.invalid).toBe('title');
    act(() => result.current.changeTitle('  product review  '));
    expect(result.current.invalid).toBeUndefined();

    act(() => result.current.changeSelection(['writer']));
    expect(await act(() => result.current.submit())).toBe('members');
    expect(result.current.memberHint).toBe('membersRequired');
    expect(result.current.memberHintDanger).toBe(true);

    act(() => result.current.changeSelection(['writer', 'codex']));
    expect(result.current.invalid).toBeUndefined();
    await waitFor(() => expect(result.current.memberHint).toBe('readiness.blocked'));
    expect(await act(() => result.current.submit())).toBe('members');
    expect(resolveChannelSelections).not.toHaveBeenCalled();
    expect(result.current.dirty).toBe(true);

    // Swap the offline device Agent for a ready one and the hint returns to the rule.
    act(() => result.current.changeSelection(['writer', 'reviewer']));
    await waitFor(() => expect(result.current.memberHint).toBe('membersHint'));
    expect(result.current.memberHintDanger).toBe(false);
    vi.mocked(resolveChannelSelections).mockResolvedValue([
      { agentId: 'writer' },
      { agentId: 'reviewer' },
    ]);
    expect(await act(() => result.current.submit())).toBeUndefined();
    expect(channelService.create).toHaveBeenCalledWith({
      members: [{ agentId: 'writer' }, { agentId: 'reviewer' }],
      title: 'product review',
    });
    expect(onCreated).toHaveBeenCalledWith('c1');
    expect(onDone).toHaveBeenCalled();
  });

  it('lets the user place an unrouted device Agent and sends that choice on submit', async () => {
    vi.mocked(deviceService.listDevices).mockResolvedValue([
      { deviceId: 'mac', online: true },
    ] as Devices);
    // Codex has no binding yet, so routing alone cannot place it anywhere.
    vi.mocked(resolveChannelCandidates).mockResolvedValue({
      candidates: [
        { agentId: 'writer', heterogeneous: false, name: 'writer' },
        {
          agentId: 'codex',
          heterogeneous: true,
          heteroType: 'codex',
          issue: 'unrouted',
          name: 'codex',
        },
      ],
      devices: [],
    } as Candidates);
    vi.mocked(agentService.queryAgents).mockResolvedValue([
      listed('writer'),
      listed('codex', { heteroType: 'codex' }),
    ]);
    const { result, onDone } = renderForm();
    act(() => {
      result.current.changeTitle('pairing');
      result.current.changeSelection(['writer', 'codex']);
    });
    await waitFor(() => expect(rowsOf(result).codex).toBe('readiness.unrouted'));
    // Native Agents get no environment controls; the device Agent's are seeded from routing.
    expect(result.current.environmentOf('writer')).toBeUndefined();
    expect(result.current.environmentOf('codex')).toEqual({ deviceId: '', workingDirectory: '' });

    act(() => result.current.changeEnvironment('codex', { deviceId: 'mac', workingDirectory: '' }));
    expect(rowsOf(result).codex).toBe('readiness.noDirectory');
    act(() =>
      result.current.changeEnvironment('codex', { deviceId: 'mac', workingDirectory: '/repo' }),
    );
    expect(rowsOf(result).codex).toBeUndefined();
    expect(result.current.environmentOf('codex')).toEqual({
      deviceId: 'mac',
      workingDirectory: '/repo',
    });
    expect(result.current.memberHint).toBe('membersHint');

    vi.mocked(resolveChannelSelections).mockResolvedValue([
      { agentId: 'writer' },
      { agentId: 'codex', deviceId: 'mac', workingDirectory: '/repo' },
    ]);
    expect(await act(() => result.current.submit())).toBeUndefined();
    expect(resolveChannelSelections).toHaveBeenCalledWith(['writer', 'codex'], {
      codex: { deviceId: 'mac', workingDirectory: '/repo' },
    });
    expect(onDone).toHaveBeenCalled();
  });

  it('flags when fewer Agents than the minimum can join', async () => {
    vi.mocked(agentService.queryAgents).mockResolvedValue([
      listed('writer'),
      listed('legacy', { heteroType: 'cursor' }),
    ]);
    const { result } = renderForm();
    expect(result.current.needMoreAgents).toBe(false); // list still loading
    await waitFor(() => expect(result.current.needMoreAgents).toBe(true));
    expect(result.current.eligibleCount).toBe(1);
  });

  it('keeps readiness failures verbatim and wraps server failures in localized copy', async () => {
    vi.mocked(agentService.queryAgents).mockResolvedValue([listed('writer'), listed('reviewer')]);
    const { result, onDone } = renderForm();
    act(() => {
      result.current.changeTitle('review');
      result.current.changeSelection(['writer', 'reviewer']);
    });
    await waitFor(() => expect(result.current.memberHint).toBe('membersHint'));

    vi.mocked(resolveChannelSelections).mockRejectedValue(
      new ChannelReadinessError('writer, reviewer are not ready', []),
    );
    await act(() => result.current.submit());
    expect(result.current.error).toEqual({ message: 'writer, reviewer are not ready' });

    // Editing the selection clears the stale error.
    act(() => result.current.changeSelection(['writer']));
    expect(result.current.error).toBeUndefined();
    act(() => result.current.changeSelection(['writer', 'reviewer']));

    vi.mocked(resolveChannelSelections).mockResolvedValue([
      { agentId: 'writer' },
      { agentId: 'reviewer' },
    ]);
    vi.mocked(channelService.create).mockRejectedValue(
      new Error('Configure a model in this Agent before joining a Channel'),
    );
    await act(() => result.current.submit());
    expect(result.current.error).toEqual({
      detail: 'Configure a model in this Agent before joining a Channel',
      message: 'createFailed',
    });
    expect(result.current.busy).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
  });
});
