'use client';

import type { DeviceListItem } from '@lobechat/types';
import { Button, Flexbox, Icon, Popover, Tag, toast, Tooltip } from '@lobehub/ui';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  GATEWAY_ERROR_MESSAGE_KEYS,
  isGatewayFailureRetryable,
} from '@/features/Electron/connection/gatewayFailure';
import { useElectronStore } from '@/store/electron';

import { useExecutionDeviceHealth } from '../../ControlBar/useExecutionDeviceHealth';
import { useAgentId } from '../../hooks/useAgentId';
import { useEffectiveAgentMode } from '../../hooks/useEffectiveAgentMode';

const styles = stylex.create({
  desc: {
    color: cssVar.colorTextSecondary,
    fontSize: 12,
    lineHeight: 1.5,
  },
  error: {
    color: cssVar.colorError,
    fontSize: 12,
    lineHeight: 1.5,
  },
  panel: {
    padding: 4,
    width: 264,
  },
  title: {
    color: cssVar.colorText,
    fontSize: 14,
    fontWeight: 500,
    lineHeight: 1.4,
  },
  // The tag is the visible chip; the wrapper only carries focus and the click.
  trigger: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderRadius: 999,
    borderStyle: 'none',
    cursor: 'pointer',
    display: 'inline-flex',
    padding: 0,
  },
  triggerStatic: {
    cursor: 'default',
  },
});

const WarningTag = ({ label }: { label: string }) => (
  <Tag color={'warning'} icon={<Icon icon={TriangleAlertIcon} />} shape={'round'}>
    {label}
  </Tag>
);

const deviceName = (device?: DeviceListItem) =>
  device ? device.friendlyName || device.hostname || device.deviceId : undefined;

/**
 * A remote machine only reconnects from that machine, so the hint points to
 * another device instead of offering an action.
 */
const RemoteDeviceHint = memo<{ device?: DeviceListItem }>(({ device }) => {
  const { t } = useTranslation('chat');
  const name = deviceName(device);
  const tip = name
    ? t('heteroAgent.executionTarget.hint.remote.tooltip', { name })
    : t('heteroAgent.executionTarget.hint.remote.tooltipUnknown');

  return (
    <Tooltip title={tip}>
      <span
        aria-label={tip}
        data-kind={'remote'}
        data-testid={'execution-device-hint'}
        role={'status'}
        tabIndex={0}
        {...stylex.props(styles.trigger, styles.triggerStatic)}
      >
        <WarningTag label={t('heteroAgent.executionTarget.hint.remote.label')} />
      </span>
    </Tooltip>
  );
});

RemoteDeviceHint.displayName = 'RemoteDeviceHint';

interface LocalDeviceHintProps {
  onReconnect: () => void;
  pending: boolean;
  reconnecting: boolean;
}

/** This desktop's own gateway connection is down; it can reconnect right here. */
const LocalDeviceHint = memo<LocalDeviceHintProps>(({ onReconnect, pending, reconnecting }) => {
  const { t } = useTranslation(['chat', 'electron']);
  const failure = useElectronStore((s) => s.gatewayConnectionError);
  const [open, setOpen] = useState(false);
  const shownFailure = pending ? undefined : failure;

  const content = (
    <Flexbox gap={12} {...stylex.props(styles.panel)}>
      <Flexbox gap={4}>
        <span {...stylex.props(styles.title)}>
          {t('heteroAgent.executionTarget.hint.local.title')}
        </span>
        <span {...stylex.props(styles.desc)}>
          {t(
            reconnecting
              ? 'heteroAgent.executionTarget.hint.local.reconnectingDesc'
              : 'heteroAgent.executionTarget.hint.local.desc',
          )}
        </span>
        {shownFailure && (
          <span title={shownFailure.detail} {...stylex.props(styles.error)}>
            {t(GATEWAY_ERROR_MESSAGE_KEYS[shownFailure.code], { ns: 'electron' })}
          </span>
        )}
      </Flexbox>
      {isGatewayFailureRetryable(shownFailure?.code) && (
        <Button
          block
          data-testid={'execution-device-reconnect'}
          icon={RefreshCwIcon}
          loading={pending}
          size={'small'}
          type={'primary'}
          onClick={onReconnect}
        >
          {t('heteroAgent.executionTarget.hint.local.reconnect')}
        </Button>
      )}
    </Flexbox>
  );

  return (
    <Popover
      arrow={false}
      content={content}
      open={open}
      placement={'topLeft'}
      trigger={'click'}
      onOpenChange={setOpen}
    >
      <button
        aria-expanded={open}
        aria-haspopup={'dialog'}
        data-kind={'local'}
        data-testid={'execution-device-hint'}
        type={'button'}
        {...stylex.props(styles.trigger)}
      >
        <WarningTag label={t('heteroAgent.executionTarget.hint.local.label')} />
      </button>
    </Popover>
  );
});

LocalDeviceHint.displayName = 'LocalDeviceHint';

const ExecutionDeviceHint = memo<{ agentId: string }>(({ agentId }) => {
  const { t } = useTranslation('chat');
  const health = useExecutionDeviceHealth(agentId);
  const connectGateway = useElectronStore((s) => s.connectGateway);
  const gatewayStatus = useElectronStore((s) => s.gatewayConnectionStatus);
  // A reconnect started from the hint keeps it (and its spinner) on screen
  // while the attempt is `connecting`, which on its own reads as healthy.
  const [pending, setPending] = useState(false);
  const wasOffline = useRef(false);

  const showLocal = health.kind === 'local' || pending;

  // Confirm the recovery the hint was reporting, whoever reconnected it.
  useEffect(() => {
    if (showLocal) {
      wasOffline.current = true;
      return;
    }
    if (wasOffline.current && gatewayStatus === 'connected') {
      toast.success(t('heteroAgent.executionTarget.hint.local.reconnected'));
    }
    wasOffline.current = false;
  }, [showLocal, gatewayStatus, t]);

  const reconnect = async () => {
    setPending(true);
    try {
      await connectGateway();
    } finally {
      setPending(false);
    }
  };

  if (health.kind === 'remote') return <RemoteDeviceHint device={health.device} />;
  if (!showLocal) return null;

  return (
    <LocalDeviceHint
      pending={pending}
      reconnecting={health.kind === 'local' && health.reconnecting}
      onReconnect={() => void reconnect()}
    />
  );
});

ExecutionDeviceHint.displayName = 'ExecutionDeviceHint';

/**
 * Composer hint for an execution device that cannot be reached: a warning tag
 * beside the approval mode, so a run is not sent to a machine that is offline.
 * Tool execution only exists in the Agent runtime, so a chat-only model shows
 * nothing.
 */
const DeviceStatus = memo(() => {
  const agentId = useAgentId();
  const { isAgentRuntimeMode } = useEffectiveAgentMode(agentId);

  if (!agentId || !isAgentRuntimeMode) return null;

  return <ExecutionDeviceHint agentId={agentId} />;
});

DeviceStatus.displayName = 'DeviceStatusAction';

export default DeviceStatus;
