'use client';

import type { DeviceListItem } from '@lobechat/types';
import { Button, Flexbox, Popover, Tooltip } from '@lobehub/ui';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { RefreshCwIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getGatewayConnectionView } from '@/helpers/gatewayConnection';
import { useElectronStore } from '@/store/electron';

import { ChatInputWarningTag } from '../../components/ChatInputWarningTag';
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
        <ChatInputWarningTag label={t('heteroAgent.executionTarget.hint.remote.label')} />
      </span>
    </Tooltip>
  );
});

RemoteDeviceHint.displayName = 'RemoteDeviceHint';

interface LocalDeviceHintProps {
  reconnecting: boolean;
}

/** This desktop's own gateway connection is down; it can reconnect right here. */
const LocalDeviceHint = memo<LocalDeviceHintProps>(({ reconnecting }) => {
  const { t } = useTranslation(['chat', 'electron']);
  const failure = useElectronStore((s) => s.gatewayConnectionError);
  const status = useElectronStore((s) => s.gatewayConnectionStatus);
  const pending = useElectronStore((s) => s.gatewayReconnectPending);
  const connectGateway = useElectronStore((s) => s.connectGateway);
  const setConnectionDrawerOpen = useElectronStore((s) => s.setConnectionDrawerOpen);
  const view = getGatewayConnectionView(status, failure, pending);
  const needsLogin = !view.isConnecting && failure?.code === 'not_signed_in';
  const [open, setOpen] = useState(false);

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
        {failure && !view.isConnecting && (
          <span title={failure.detail} {...stylex.props(styles.error)}>
            {t(view.messageKey, { ns: 'electron' })}
          </span>
        )}
      </Flexbox>
      {(view.canReconnect || view.isConnecting || needsLogin) && (
        <Button
          block
          data-testid={'execution-device-reconnect'}
          icon={RefreshCwIcon}
          loading={view.isConnecting}
          size={'small'}
          type={'primary'}
          onClick={() => (needsLogin ? setConnectionDrawerOpen(true) : void connectGateway())}
        >
          {t(
            needsLogin
              ? 'gateway.signIn'
              : view.isConnecting
                ? 'gateway.reconnecting'
                : 'gateway.reconnect',
            { ns: 'electron' },
          )}
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
        <ChatInputWarningTag
          label={
            view.isConnecting
              ? t('gateway.reconnecting', { ns: 'electron' })
              : t('heteroAgent.executionTarget.hint.local.label')
          }
        />
      </button>
    </Popover>
  );
});

LocalDeviceHint.displayName = 'LocalDeviceHint';

const ExecutionDeviceHint = ({ agentId }: { agentId: string }) => {
  const health = useExecutionDeviceHealth(agentId);
  const showLocal = health.kind === 'local';

  if (health.kind === 'remote') return <RemoteDeviceHint device={health.device} />;
  if (!showLocal) return null;

  return <LocalDeviceHint reconnecting={health.kind === 'local' && health.reconnecting} />;
};

ExecutionDeviceHint.displayName = 'ExecutionDeviceHint';

/**
 * Composer hint for an execution device that cannot be reached: a warning tag
 * beside the approval mode, so a run is not sent to a machine that is offline.
 * Tool execution only exists in the Agent runtime, so a chat-only model shows
 * nothing.
 */
const DeviceStatus = () => {
  const agentId = useAgentId();
  const { isAgentRuntimeMode } = useEffectiveAgentMode(agentId);

  if (!agentId || !isAgentRuntimeMode) return null;

  return <ExecutionDeviceHint agentId={agentId} />;
};

DeviceStatus.displayName = 'DeviceStatusAction';

export default DeviceStatus;
