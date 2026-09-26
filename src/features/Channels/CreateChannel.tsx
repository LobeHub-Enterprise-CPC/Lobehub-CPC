import { agentDisplayName } from '@lobechat/types';
import { Flexbox, Input, SearchBar } from '@lobehub/ui';
import { Avatar, Button, Select } from '@lobehub/ui/base-ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import { openConnectAgentModal } from '@/features/ConnectAgent';
import { useCreateMenuItems } from '@/features/HomeSidebar/hooks/useCreateMenuItems';
import { agentService } from '@/services/agent';
import { channelService } from '@/services/channel';
import { deviceService } from '@/services/device';

import { styles } from './styles';
import { useChannelDevice } from './useChannelDevice';

export function CreateChannel({
  onCreated,
  onCancel,
  existing,
}: {
  onCreated: (id: string) => void;
  onCancel: () => void;
  existing?: {
    id: string;
    capacity: number;
    agentIds: string[];
    deviceId?: string;
    workingDirectory?: string;
  };
}) {
  const { t } = useTranslation('channel');
  const { createAgent, openCreateModal } = useCreateMenuItems();
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const {
    data: agents,
    error: agentsError,
    mutate: refreshAgents,
  } = useSWR('channel-existing-agents', () => agentService.queryAgents());
  const capacity = existing?.capacity ?? 4;
  const {
    device,
    deviceConflict,
    deviceId,
    devices,
    devicesError,
    directory,
    fixedDeviceId,
    needsDevice,
    ready,
    setDeviceId,
    setDirectory,
  } = useChannelDevice(
    (agents || []).filter((agent) => selected.includes(agent.id)),
    existing,
  );
  const deviceError = deviceConflict
    ? t('deviceConflict')
    : needsDevice && deviceId && devices && !device?.online
      ? t('deviceUnavailable')
      : '';
  const valid = (existing || title.trim()) && selected.length > 0 && ready;
  const submit = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setError('');
    try {
      if (needsDevice) {
        await deviceService.updateDevice({
          deviceId,
          workingDirs: [
            { path: directory.trim() },
            ...(device?.workingDirs || []).filter((item) => item.path !== directory.trim()),
          ].slice(0, 20),
        });
      }
      const members = selected.map((agentId) => ({
        agentId,
        ...(needsDevice ? { deviceId, workingDirectory: directory.trim() } : {}),
      }));
      if (existing) {
        await channelService.addMembers({ channelId: existing.id, members });
        onCreated(existing.id);
      } else {
        const channel = await channelService.create({ title, members });
        onCreated(channel.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const visible = (agents || []).filter(
    (agent) =>
      !existing?.agentIds.includes(agent.id) &&
      `${agentDisplayName(agent)} ${agent.description || ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <Flexbox className={styles.form} gap={20}>
      <h2>{t(existing ? 'addMembers' : 'create')}</h2>
      {!existing && (
        <label>
          {t('name')}
          <Input disabled={busy} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      )}
      <Flexbox gap={8}>
        <strong>{t('selectAgents')}</strong>
        <span className={styles.muted}>{t('existingAgentsHint')}</span>
        <Flexbox horizontal gap={8} wrap="wrap">
          {
            <Button
              size="small"
              onClick={() => (openCreateModal ? openCreateModal('agent') : createAgent())}
            >
              {t('createAgent')}
            </Button>
          }
          <Button size="small" onClick={() => openConnectAgentModal()}>
            {t('connectAgent')}
          </Button>
          <Button size="small" type="text" onClick={() => refreshAgents()}>
            {t('reload')}
          </Button>
        </Flexbox>
      </Flexbox>
      <SearchBar
        placeholder={t('searchAgents')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <Flexbox className={styles.agentList} gap={4}>
        {!agents && !agentsError && <span>{t('loading')}</span>}
        {agents && !visible.length && <span className={styles.muted}>{t('noAgents')}</span>}
        {visible.map((agent) => {
          const supported =
            !agent.heteroType || ['codex', 'amp', 'grok-build'].includes(agent.heteroType);
          const checked = selected.includes(agent.id);
          return (
            <label className={styles.agentOption} key={agent.id}>
              <input
                checked={checked}
                disabled={busy || !supported || (!checked && selected.length >= capacity)}
                type="checkbox"
                onChange={() =>
                  setSelected((ids) =>
                    checked ? ids.filter((id) => id !== agent.id) : [...ids, agent.id],
                  )
                }
              />
              <Avatar
                avatar={agent.avatar || '🤖'}
                background={agent.backgroundColor || undefined}
                size={36}
              />
              <Flexbox flex={1} gap={4}>
                <strong>{agentDisplayName(agent, agent.id)}</strong>
                <span className={styles.muted}>
                  {agent.description ||
                    (agent.heteroType === 'codex' ? t('codexAgent') : t('nativeAgent'))}
                </span>
              </Flexbox>
              <span className={styles.muted}>
                {supported ? agent.heteroType || 'LobeHub' : t('unsupportedAgent')}
              </span>
            </label>
          );
        })}
      </Flexbox>
      <span className={styles.muted}>
        {t('selectedAgents', { count: selected.length, capacity })}
      </span>
      {needsDevice && !deviceConflict && (
        <>
          <Flexbox gap={8}>
            <span>{t('device')}</span>
            {fixedDeviceId ? (
              <>
                <strong>
                  {device
                    ? `${device.friendlyName || device.hostname || device.deviceId}${device.online ? '' : ` · ${t('offline')}`}`
                    : devices || devicesError
                      ? t('deviceUnavailable')
                      : t('loading')}
                </strong>
                {!existing?.deviceId && (
                  <span className={styles.muted}>{t('boundDeviceHint')}</span>
                )}
              </>
            ) : (
              <Select
                disabled={busy}
                placeholder={t('selectDevice')}
                value={deviceId || undefined}
                options={(devices || []).map((device) => ({
                  value: device.deviceId,
                  label: `${device.friendlyName || device.hostname || device.deviceId}${device.online ? '' : ` · ${t('offline')}`}`,
                  disabled: !device.online,
                }))}
                onChange={(value) => setDeviceId(String(value))}
              />
            )}
          </Flexbox>
          <label>
            {t('directory')}
            <Input
              disabled={busy || !!existing?.workingDirectory}
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
            />
          </label>
        </>
      )}
      {(deviceError || error || agentsError || devicesError) && (
        <p className={styles.error} role="alert">
          {deviceError || error || String(agentsError || devicesError)}
        </p>
      )}
      <Flexbox horizontal gap={8} justify="flex-end">
        <Button disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button disabled={!valid || busy} loading={busy} type="primary" onClick={submit}>
          {t(existing ? 'addMembers' : 'submit')}
        </Button>
      </Flexbox>
    </Flexbox>
  );
}
