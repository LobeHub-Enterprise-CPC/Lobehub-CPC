import { CHANNEL_LIMITS, isChannelRuntime } from '@lobechat/types';
import { Flexbox, Input } from '@lobehub/ui';
import { Button, createModal, useModalContext } from '@lobehub/ui/base-ui';
import { t } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR, { useSWRConfig } from 'swr';

import { AgentMemberSelection } from '@/features/AgentMemberSelection';
import { agentService } from '@/services/agent';
import { channelService } from '@/services/channel';

import { resolveChannelSelections } from './resolveMembers';
import { styles } from './styles';

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
  const { close } = useModalContext();
  const { mutate: refresh } = useSWRConfig();
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const {
    data: agents,
    error: agentsError,
    mutate,
  } = useSWR('channel-existing-agents', () => agentService.queryAgents({ includeInbox: true }));
  const capacity = existing?.capacity ?? CHANNEL_LIMITS.members;
  const minimum = existing ? 1 : CHANNEL_LIMITS.minMembers;
  const valid =
    (existing || title.trim()) && selected.length >= minimum && selected.length <= capacity;
  const submit = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setError('');
    try {
      const members = await resolveChannelSelections(selected);
      if (existing) {
        await channelService.addMembers({ channelId: existing.id, members });
        void refresh(['channel', existing.id]);
        onCreated?.(existing.id);
      } else {
        const channel = await channelService.create({ title, members });
        void refresh('channels');
        onCreated?.(channel.id);
      }
      close();
    } catch (error) {
      setError(error instanceof Error ? error.message : t('createFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Flexbox gap={20}>
      {!existing && (
        <label>
          {t('name')}
          <Input disabled={busy} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      )}
      <AgentMemberSelection
        disabled={busy}
        existingMembers={existing?.agentIds}
        isLoading={!agents && !agentsError}
        maxCount={capacity}
        selectedAgentIds={selected}
        agents={(agents ?? []).map((agent) => ({
          ...agent,
          disabled:
            !!agent.heteroType &&
            (agent.heteroType === 'native' || !isChannelRuntime(agent.heteroType)),
        }))}
        onChange={setSelected}
      />
      {(error || agentsError) && (
        <Flexbox gap={8} role="alert">
          <span className={styles.error}>{error || t('refreshFailed')}</span>
          {agentsError && <Button onClick={() => mutate()}>{t('reload')}</Button>}
        </Flexbox>
      )}
      <Flexbox horizontal gap={8} justify="flex-end">
        <Button disabled={busy} onClick={close}>
          {t('cancel')}
        </Button>
        <Button disabled={!valid || busy} loading={busy} type="primary" onClick={submit}>
          {t(existing ? 'addMembers' : 'submit')} ({selected.length} / {capacity})
        </Button>
      </Flexbox>
    </Flexbox>
  );
}
