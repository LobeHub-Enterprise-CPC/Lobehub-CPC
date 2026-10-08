'use client';

import { Flexbox } from '@lobehub/ui';
import { Alert, Button, createModal, Text, useModalContext } from '@lobehub/ui/base-ui';
import { t } from 'i18next';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import { channelService } from '@/services/channel';
import { deviceService } from '@/services/device';

import type { EnvironmentDraft } from './EnvironmentFields';
import { EnvironmentFields } from './EnvironmentFields';

interface Props {
  channelId: string;
  memberId: string;
}

export const openMemberEnvironmentModal = (props: Props) => {
  const modal = createModal({
    content: (
      <MemberEnvironmentModal
        {...props}
        onBusyChange={(busy) =>
          modal.update({
            maskClosable: !busy,
            styles: { close: { display: busy ? 'none' : undefined } },
          })
        }
      />
    ),
    footer: null,
    maskClosable: true,
    title: t('environment.manage', { ns: 'channel' }),
    width: 640,
  });
  return modal;
};

export function MemberEnvironmentModal({
  channelId,
  memberId,
  onBusyChange,
}: Props & { onBusyChange: (busy: boolean) => void }) {
  const { t } = useTranslation('channel');
  const { close } = useModalContext();
  const {
    data,
    error: loadError,
    mutate,
  } = useSWR(['channel', channelId], () => channelService.detail(channelId), {
    refreshInterval: (detail) => {
      const member = detail?.members.find((item) => item.id === memberId);
      return member?.executionPaused ? 1000 : 0;
    },
  });
  const {
    data: devices = [],
    error: deviceError,
    mutate: refreshDevices,
  } = useSWR('channel-environment-devices', deviceService.listDevices, { refreshInterval: 5000 });
  const member = data?.members.find((item) => item.id === memberId);
  const saved = {
    deviceId: member?.config.deviceId ?? '',
    workingDirectory: member?.config.workingDirectory ?? '',
  };
  const [draft, setDraft] = useState<EnvironmentDraft | null>(null);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState<'resume' | 'save' | null>(null);
  const submitting = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    onBusyChange(!!busy);
    if (!busy) return;
    // The imperative modal's maskClosable only guards backdrop clicks, not Escape.
    const blockEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', blockEscape, true);
    return () => window.removeEventListener('keydown', blockEscape, true);
  }, [busy, onBusyChange]);
  const value = draft ?? saved;
  if ((loadError && !data) || (data && !member))
    return (
      <Alert
        description={<Button onClick={() => mutate()}>{t('reload')}</Button>}
        title={t('refreshFailed')}
      />
    );
  if (!member) return <Flexbox padding={24}>{t('loading')}</Flexbox>;
  if (member.config.runtime === 'native')
    return <Alert description={t('environment.nativeHint')} title={t('environment.nativeTitle')} />;
  const conflict = draftRevision !== null && draftRevision !== member.environmentRevision;
  const readOnly = !member.active || !!data?.channel.archived;
  const hasEnvironment = !!value.deviceId && !!value.workingDirectory.trim();
  const changed =
    value.deviceId !== saved.deviceId || value.workingDirectory.trim() !== saved.workingDirectory;
  const act = async (action: 'resume' | 'save') => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(action);
    setError('');
    try {
      const common = {
        channelId,
        expectedRevision: draftRevision ?? member.environmentRevision,
        memberId,
      };
      if (action === 'resume') {
        await channelService.resumeMember(common);
      } else {
        const result = await channelService.updateEnvironment(
          { ...common, ...value, agentId: member.config.agentId! },
          confirming,
        );
        if (result.confirmationRequired) {
          setConfirming(true);
          return;
        }
      }
      void mutate().catch(() => {});
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('environment.actionFailed'));
      setConfirming(false);
      // A lost mutation response does not prove the mutation failed. Refresh the
      // durable pause/revision before offering recovery; never auto-resume here.
      await mutate().catch(() => {});
    } finally {
      submitting.current = false;
      setBusy(null);
    }
  };
  return (
    <Flexbox gap={16}>
      {loadError && (
        <Alert
          description={<Button onClick={() => mutate()}>{t('reload')}</Button>}
          title={t('refreshFailed')}
        />
      )}
      {deviceError && (
        <Alert
          description={<Button onClick={() => refreshDevices()}>{t('reload')}</Button>}
          title={t('deviceUnavailable')}
        />
      )}
      {conflict && (
        <Alert
          title={t('environment.actionFailed')}
          description={
            <Button
              onClick={() => {
                setDraft(null);
                setDraftRevision(null);
                setError('');
                setConfirming(false);
              }}
            >
              {t('environment.resetDraft')}
            </Button>
          }
        />
      )}
      <EnvironmentFields
        agentId={member.config.agentId!}
        devices={devices}
        disabled={!!busy || confirming || conflict || readOnly || !!loadError}
        value={value}
        onChange={(next) => {
          setDraft(next);
          setDraftRevision(draftRevision ?? member.environmentRevision);
          setError('');
        }}
      />
      {confirming && (
        <Alert description={t('environment.switchWarning')} title={t('environment.warningTitle')} />
      )}
      {changed && !confirming && !busy && (
        <Text type="secondary">{t('environment.sessionHint')}</Text>
      )}
      {busy && (
        <Text role="status">
          {t(busy === 'save' ? 'environment.switching' : 'environment.resuming')}
        </Text>
      )}
      {member.executionPaused && !busy && !confirming && (
        <Alert description={t('environment.recoveryHint')} title={t('environment.recoveryTitle')} />
      )}
      {error && <Alert description={error} title={t('environment.resultUnknown')} />}
      <Flexbox horizontal gap={8} justify="flex-end">
        <Button disabled={!!busy} onClick={confirming ? () => setConfirming(false) : close}>
          {t('cancel')}
        </Button>
        {member.executionPaused && !confirming && (
          <Button
            disabled={!!busy || conflict || readOnly || !!loadError}
            loading={busy === 'resume'}
            onClick={() => act('resume')}
          >
            {t('environment.resume')}
          </Button>
        )}
        <Button
          disabled={!changed || !hasEnvironment || !!busy || conflict || readOnly || !!loadError}
          loading={busy === 'save'}
          type="primary"
          onClick={() => act('save')}
        >
          {t(
            confirming
              ? 'environment.confirmSwitch'
              : error
                ? 'environment.retry'
                : 'environment.save',
          )}
        </Button>
      </Flexbox>
    </Flexbox>
  );
}
