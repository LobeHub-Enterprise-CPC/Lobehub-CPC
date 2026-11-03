'use client';

import { isDesktop } from '@lobechat/const';
import { isRemoteHeterogeneousType } from '@lobechat/heterogeneous-agents';

import { useChatInputResourceAccess } from '@/features/ChatInput/hooks/useChatInputResourceAccess';
import { PRESENCE_REFRESH_INTERVAL_MS } from '@/features/Conversation/WorkingSidebar/Overview/useBoundDevice';
import { resolveExecutionTarget } from '@/helpers/executionTarget';
import { useIsGatewayModeEnabled } from '@/helpers/gatewayMode';
import { useEffectiveAgencyConfig } from '@/hooks/useEffectiveAgencyConfig';
import { useDeviceList } from '@/store/device';
import { useElectronStore } from '@/store/electron';

import { useTopicId } from '../hooks/useTopicId';
import { type ExecutionDeviceHealth, resolveExecutionDeviceHealth } from './executionDeviceHealth';

/**
 * Reachability of the device the next run in this composer executes on.
 *
 * Resolves the execution target from the same inputs as
 * `useExecutionTargetController` (effective agency config, gateway mode,
 * desktop availability), without that controller's selection side effects, so
 * a second surface can read it.
 */
export const useExecutionDeviceHealth = (agentId: string): ExecutionDeviceHealth => {
  const topicId = useTopicId();
  const { canUseResource } = useChatInputResourceAccess();
  const {
    agencyConfig,
    canDisplayExecutionTarget,
    isPreferenceLoading,
    topicDeviceUnknown,
    workspaceScoped,
  } = useEffectiveAgencyConfig(agentId, { topicId });
  const deviceRoutingAvailable = useIsGatewayModeEnabled(agentId);

  const heteroType = agencyConfig?.heterogeneousProvider?.type;
  const isHetero = !!heteroType;
  const executionTarget = resolveExecutionTarget(agencyConfig, {
    clientExecutionAvailable: isDesktop,
    deviceRoutingAvailable,
    isHetero,
    workspaceScoped,
  });

  // A remote machine's presence only changes on the server, so the hint
  // re-reads it the way the bound-device panel does.
  const { data: devices, isConfirmed } = useDeviceList({
    refreshInterval: executionTarget === 'device' ? PRESENCE_REFRESH_INTERVAL_MS : 0,
  });

  // Reads this desktop's status once; broadcasts keep the store current
  // (the title-bar `DeviceGateway` entry). `data` stays undefined until that
  // first read, so the store's initial `disconnected` is never reported.
  const { data: fetchedGatewayState } = useElectronStore((s) => s.useFetchGatewayStatus)();
  useElectronStore((s) => s.useFetchGatewayDeviceInfo)();
  const gatewayStatus = useElectronStore((s) => s.gatewayConnectionStatus);
  const currentDeviceId = useElectronStore((s) => s.gatewayDeviceInfo?.deviceId);

  if (!canUseResource || !canDisplayExecutionTarget || isPreferenceLoading || topicDeviceUnknown)
    return { kind: 'ok' };

  // A local CLI agent (Claude Code, Codex, …) is spawned by the desktop itself;
  // only gateway-mode runs and notify-based platform agents reach this
  // machine through the device gateway (see `agentDispatcher`).
  const localRunsThroughGateway = isHetero
    ? isRemoteHeterogeneousType(heteroType)
    : deviceRoutingAvailable;

  return resolveExecutionDeviceHealth({
    boundDeviceId: agencyConfig?.boundDeviceId,
    currentDeviceId: isDesktop ? currentDeviceId : undefined,
    devices,
    devicesConfirmed: isConfirmed,
    executionTarget,
    gatewayStatus: fetchedGatewayState ? gatewayStatus : undefined,
    isDesktop,
    localRunsThroughGateway,
  });
};
