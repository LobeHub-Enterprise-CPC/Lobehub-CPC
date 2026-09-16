import { CHANNEL_LIMITS } from '@lobechat/types';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR, { useSWRConfig } from 'swr';

import { agentService } from '@/services/agent';
import { channelService } from '@/services/channel';
import { deviceService } from '@/services/device';

import {
  applyChannelEnvironment,
  type ChannelMemberEnvironment,
  type ChannelMemberIssue,
  ChannelReadinessError,
  isUnsupportedChannelRuntime,
  resolveChannelCandidates,
  resolveChannelSelections,
} from './resolveMembers';

export interface CreateChannelTarget {
  /** Set when adding members to a Channel that already exists. */
  existing?: { id: string; capacity: number; agentIds: string[] };
  onCreated?: (id: string) => void;
  onDone: () => void;
}

/** A local rule the last submit attempt tripped; cleared as soon as the user edits. */
export type CreateChannelRule = 'title' | 'members';

type ListedAgent = Awaited<ReturnType<typeof agentService.queryAgents>>[number];

/**
 * State, readiness diagnosis and submission for the create / add-members dialog.
 * The component only renders what this returns and owns focus and modal wiring.
 */
export function useCreateChannelForm({ existing, onCreated, onDone }: CreateChannelTarget) {
  const { t } = useTranslation('channel');
  const { mutate: refresh } = useSWRConfig();
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  // Device and directory the user picked per member, overriding the Agent's own routing.
  const [environments, setEnvironments] = useState<Record<string, ChannelMemberEnvironment>>({});
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<CreateChannelRule>();
  const [error, setError] = useState<{ detail?: string; message: string }>();
  const {
    data: agents,
    error: agentsError,
    mutate: reloadAgents,
  } = useSWR('channel-existing-agents', () => agentService.queryAgents({ includeInbox: true }));
  const candidates = (agents ?? []).filter((agent) => !existing?.agentIds.includes(agent.id));
  // Device presence is cheap and lets unselected device Agents show "offline" before a click.
  const { data: devices } = useSWR(
    candidates.some((agent) => agent.heteroType) ? 'channel-environment-devices' : null,
    deviceService.listDevices,
    { refreshInterval: 5000 },
  );
  // Full readiness (routing, working directory, model) needs each selected Agent's config.
  const {
    data: readiness,
    error: readinessError,
    isLoading: checking,
  } = useSWR(
    selected.length ? ['channel-candidates', ...selected] : null,
    () => resolveChannelCandidates(selected),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  const knownDevices = devices ?? readiness?.devices ?? [];
  const candidateOf = (agentId: string) => {
    const diagnosed = readiness?.candidates.find((candidate) => candidate.agentId === agentId);
    return diagnosed && applyChannelEnvironment(diagnosed, environments[agentId], knownDevices);
  };
  const issueOf = (agent: ListedAgent): ChannelMemberIssue | undefined => {
    const diagnosed = candidateOf(agent.id);
    if (diagnosed) return diagnosed.issue;
    if (isUnsupportedChannelRuntime(agent.heteroType ?? undefined)) return 'unsupported';
    if (agent.heteroType && agent.boundDeviceId && devices)
      return devices.some((device) => device.deviceId === agent.boundDeviceId && device.online)
        ? undefined
        : 'offline';
    return undefined;
  };
  const rows = candidates.map((agent) => {
    const issue = issueOf(agent);
    return {
      ...agent,
      disabled: issue === 'unsupported',
      issue,
      status: issue && (issue === 'unsupported' ? t('unsupportedAgent') : t(`readiness.${issue}`)),
    };
  });

  const capacity = existing?.capacity ?? CHANNEL_LIMITS.members;
  const minimum = existing ? 1 : CHANNEL_LIMITS.minMembers;
  const eligibleCount = rows.filter((row) => row.issue !== 'unsupported').length;
  const blockedCount = rows.filter((row) => row.issue && selected.includes(row.id)).length;
  const membersInvalid = invalid === 'members';
  const memberHint = () => {
    if (blockedCount) return t('readiness.blocked', { count: blockedCount });
    if (membersInvalid) return t('membersRequired', { min: minimum });
    if (checking) return t('readiness.checking');
    if (readinessError) return t('readiness.checkFailed');
    return existing
      ? t('membersRemaining', { count: capacity })
      : t('membersHint', { max: capacity, min: minimum });
  };

  const changeTitle = (value: string) => {
    setTitle(value);
    setInvalid(undefined);
    setError(undefined);
  };
  const changeSelection = (ids: string[]) => {
    setSelected(ids);
    setInvalid(undefined);
    setError(undefined);
  };
  const changeEnvironment = (agentId: string, environment: ChannelMemberEnvironment) => {
    setEnvironments((current) => ({ ...current, [agentId]: environment }));
    setError(undefined);
  };
  /** Only device Agents run somewhere; native ones need no environment controls. */
  const environmentOf = (agentId: string) => {
    const candidate = candidateOf(agentId);
    if (!candidate?.heterogeneous) return undefined;
    return (
      environments[agentId] ?? {
        deviceId: candidate.deviceId ?? '',
        workingDirectory: candidate.workingDirectory ?? '',
      }
    );
  };

  /** Resolves to the local rule that blocked the attempt, or `undefined` once submission ran. */
  const submit = async (): Promise<CreateChannelRule | undefined> => {
    if (busy) return;
    // Say which rule failed instead of leaving the button silently disabled.
    if (!existing && !title.trim()) {
      setInvalid('title');
      return 'title';
    }
    if (selected.length < minimum || selected.length > capacity || blockedCount) {
      setInvalid('members');
      return 'members';
    }
    setBusy(true);
    setError(undefined);
    try {
      const members = await resolveChannelSelections(selected, environments);
      if (existing) {
        await channelService.addMembers({ channelId: existing.id, members });
        void refresh(['channel', existing.id]);
        onCreated?.(existing.id);
      } else {
        const channel = await channelService.create({ title: title.trim(), members });
        void refresh('channels');
        onCreated?.(channel.id);
      }
      onDone();
    } catch (error) {
      // Readiness errors are already localized and name the Agents; server errors are not.
      setError(
        error instanceof ChannelReadinessError
          ? { message: error.message }
          : {
              detail: error instanceof Error ? error.message : undefined,
              message: t('createFailed'),
            },
      );
    } finally {
      setBusy(false);
    }
  };

  return {
    agentsError,
    busy,
    capacity,
    changeEnvironment,
    changeSelection,
    changeTitle,
    devices: knownDevices,
    dirty: !!title || selected.length > 0,
    eligibleCount,
    environmentOf,
    error,
    invalid,
    loadingAgents: !agents && !agentsError,
    memberHint: memberHint(),
    memberHintDanger: blockedCount > 0 || membersInvalid,
    minimum,
    /** Once the list has loaded, fewer eligible Agents than the Channel needs. */
    needMoreAgents: !!agents && eligibleCount < minimum,
    reloadAgents,
    rows,
    selected,
    submit,
    title,
  };
}
