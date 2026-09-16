import { CHANNEL_LIMITS } from '@lobechat/types';
import { Flexbox, Icon, Input } from '@lobehub/ui';
import { Button, createModal, Text, useModalContext } from '@lobehub/ui/base-ui';
import { t } from 'i18next';
import { Hash } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR, { useSWRConfig } from 'swr';

import { AgentMemberSelection } from '@/features/AgentMemberSelection';
import { useCreateMenuItems } from '@/features/HomeSidebar/hooks';
import { usePermission } from '@/hooks/usePermission';
import { agentService } from '@/services/agent';
import { channelService } from '@/services/channel';
import { deviceService } from '@/services/device';

import {
  type ChannelMemberIssue,
  ChannelReadinessError,
  isUnsupportedChannelRuntime,
  resolveChannelCandidates,
  resolveChannelSelections,
} from './resolveMembers';
import { styles } from './styles';

/** Matches the `title` bound in `apps/server/src/routers/lambda/channel.ts`. */
const TITLE_MAX_LENGTH = 200;

interface CreateChannelProps {
  existing?: { id: string; capacity: number; agentIds: string[] };
  onCreated?: (id: string) => void;
}

export function openCreateChannelModal(props: CreateChannelProps = {}) {
  return createModal({
    content: <CreateChannel {...props} />,
    footer: null,
    title: t(props.existing ? 'addMembers' : 'create', { ns: 'channel' }),
    width: 800,
  });
}

function CreateChannel({ onCreated, existing }: CreateChannelProps) {
  const { t } = useTranslation('channel');
  const { close, setCanDismissByClickOutside } = useModalContext();
  const { mutate: refresh } = useSWRConfig();
  const { allowed: canCreateAgent } = usePermission('create_content');
  const { createAgent } = useCreateMenuItems();
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ detail?: string; message: string }>();
  const {
    data: agents,
    error: agentsError,
    mutate,
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

  const issueOf = (agent: {
    boundDeviceId?: string | null;
    heteroType?: string | null;
    id: string;
  }) => {
    const diagnosed = readiness?.candidates.find((candidate) => candidate.agentId === agent.id);
    if (diagnosed) return diagnosed.issue;
    if (isUnsupportedChannelRuntime(agent.heteroType ?? undefined)) return 'unsupported';
    if (agent.heteroType && agent.boundDeviceId && devices)
      return devices.some((device) => device.deviceId === agent.boundDeviceId && device.online)
        ? undefined
        : 'offline';
    return undefined;
  };
  const issueLabel = (issue: ChannelMemberIssue) =>
    issue === 'unsupported' ? t('unsupportedAgent') : t(`readiness.${issue}`);

  const capacity = existing?.capacity ?? CHANNEL_LIMITS.members;
  const minimum = existing ? 1 : CHANNEL_LIMITS.minMembers;
  const eligibleCount = candidates.filter((agent) => issueOf(agent) !== 'unsupported').length;
  const blockedCount = selected.filter((id) => {
    const agent = candidates.find((item) => item.id === id);
    return agent && issueOf(agent);
  }).length;
  const valid =
    (existing || title.trim()) &&
    selected.length >= minimum &&
    selected.length <= capacity &&
    blockedCount === 0 &&
    !checking;
  const dirty = !!title || selected.length > 0;

  // A mask click must not drop what the user typed or picked; ✕ and Esc still close.
  useEffect(() => {
    setCanDismissByClickOutside(!dirty);
  }, [dirty, setCanDismissByClickOutside]);

  const changeTitle = (value: string) => {
    setTitle(value);
    setError(undefined);
  };
  const changeSelection = (ids: string[]) => {
    setSelected(ids);
    setError(undefined);
  };
  const submit = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setError(undefined);
    try {
      const members = await resolveChannelSelections(selected);
      if (existing) {
        await channelService.addMembers({ channelId: existing.id, members });
        void refresh(['channel', existing.id]);
        onCreated?.(existing.id);
      } else {
        const channel = await channelService.create({ title: title.trim(), members });
        void refresh('channels');
        onCreated?.(channel.id);
      }
      close();
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
  const openCreateAgent = async () => {
    close();
    await createAgent();
  };
  const openConnectAgent = async () => {
    close();
    const { openConnectAgentModal } = await import('@/features/ConnectAgent');
    openConnectAgentModal();
  };

  const memberHint = () => {
    if (checking) return t('readiness.checking');
    if (blockedCount) return t('readiness.blocked', { count: blockedCount });
    if (readinessError) return t('readiness.checkFailed');
    return existing
      ? t('membersRemaining', { count: capacity })
      : t('membersHint', { max: capacity, min: minimum });
  };

  return (
    <Flexbox gap={20}>
      {!existing && (
        <Flexbox gap={8}>
          <Text type="secondary">{t('description')}</Text>
          <Flexbox gap={6}>
            <label htmlFor="channel-title" style={{ fontWeight: 500 }}>
              {t('name')}
            </label>
            <Input
              autoFocus
              disabled={busy}
              id="channel-title"
              maxLength={TITLE_MAX_LENGTH}
              placeholder={t('namePlaceholder')}
              prefix={<Icon icon={Hash} size={14} />}
              value={title}
              onChange={(e) => changeTitle(e.target.value)}
              onPressEnter={() => void submit()}
            />
          </Flexbox>
        </Flexbox>
      )}
      <Flexbox gap={8}>
        <Flexbox horizontal align="baseline" gap={12} justify="space-between">
          <Text weight={500}>{t('members')}</Text>
          <Text fontSize={12} type={blockedCount ? 'danger' : 'secondary'}>
            {memberHint()}
          </Text>
        </Flexbox>
        <AgentMemberSelection
          disabled={busy}
          existingMembers={existing?.agentIds}
          isLoading={!agents && !agentsError}
          maxCount={capacity}
          selectedAgentIds={selected}
          agents={candidates.map((agent) => {
            const issue = issueOf(agent);
            return {
              ...agent,
              disabled: issue === 'unsupported',
              status: issue ? issueLabel(issue) : undefined,
            };
          })}
          onChange={changeSelection}
        />
        {agents && eligibleCount < minimum && (
          <Flexbox horizontal align="center" gap={8} wrap="wrap">
            <span className={styles.muted}>
              {eligibleCount
                ? t('needMoreAgents', { count: eligibleCount, min: minimum })
                : t('noAgents')}
            </span>
            {canCreateAgent && (
              <>
                <Button size="small" onClick={openCreateAgent}>
                  {t('createAgent')}
                </Button>
                <Button size="small" onClick={openConnectAgent}>
                  {t('connectAgent')}
                </Button>
              </>
            )}
          </Flexbox>
        )}
      </Flexbox>
      {(error || agentsError) && (
        <Flexbox gap={8} role="alert">
          <span className={styles.error}>{error?.message || t('refreshFailed')}</span>
          {error?.detail && <span className={styles.muted}>{error.detail}</span>}
          {agentsError && <Button onClick={() => mutate()}>{t('reload')}</Button>}
        </Flexbox>
      )}
      <Flexbox horizontal gap={8} justify="flex-end">
        <Button disabled={busy} onClick={close}>
          {t('cancel')}
        </Button>
        <Button disabled={!valid || busy} loading={busy} type="primary" onClick={submit}>
          {t(existing ? 'addMembers' : 'submit')}
        </Button>
      </Flexbox>
    </Flexbox>
  );
}
