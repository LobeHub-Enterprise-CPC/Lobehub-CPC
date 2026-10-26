'use client';

import { CLI_PRIMARY_BIN, DESKTOP_APP_ENABLED } from '@lobechat/business-const';
import { isDesktop } from '@lobechat/const';
import type { DeviceExecutionTarget, DeviceListItem } from '@lobechat/types';
import { toast } from '@lobehub/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useChatInputResourceAccess } from '@/features/ChatInput/hooks/useChatInputResourceAccess';
import { useLocalSandboxCapability } from '@/features/ChatInput/hooks/useLocalSandboxCapability';
import { useSelectExecutionTarget } from '@/features/ChatInput/hooks/useSelectExecutionTarget';
import { useDesktopDownload } from '@/features/Downloads/useDesktopDownload';
import { devicePoolForAgent, groupExecutionTargetDevices } from '@/features/ExecutionTargetPicker';
import {
  isHeterogeneousSandboxExecutionAvailable,
  isLocalSandboxEnabled,
  resolveExecutionTarget,
} from '@/helpers/executionTarget';
import { useIsGatewayModeEnabled } from '@/helpers/gatewayMode';
import { useEffectiveAgencyConfig } from '@/hooks/useEffectiveAgencyConfig';
import { localFileService } from '@/services/electron/localFileService';
import { useAgentStore } from '@/store/agent';
import { useDeviceList } from '@/store/device';
import { useElectronStore } from '@/store/electron';

import { useTopicId } from '../hooks/useTopicId';
import { getDevicePoolStatus } from './devicePoolStatus';
import { useSandboxNetworkToggle } from './useSandboxNetworkToggle';
import { useTopicAwareTargetSelect } from './useTopicAwareTargetSelect';

/**
 * Execution-target state shared by the legacy device chip and the place picker.
 * Both views call this; neither re-implements selection, reconnect, or the
 * desktop's first-open local default.
 */
export const useExecutionTargetController = (agentId: string) => {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const { canUseResource } = useChatInputResourceAccess();
  const topicId = useTopicId();
  const agentWorkspaceId = useAgentStore((s) => s.agentMap[agentId]?.workspaceId);
  const isWorkspaceAgent = Boolean(agentWorkspaceId);

  const {
    agencyConfig,
    canDisplayExecutionTarget,
    canSelectExecutionTarget,
    isPreferenceLoading: isWorkspacePreferenceLoading,
    topicDeviceUnknown,
    workspaceScoped,
  } = useEffectiveAgencyConfig(agentId, { topicId });
  const canShowExecutionTarget = canUseResource && canDisplayExecutionTarget;
  const canShowExecutionTargetSelector = canShowExecutionTarget && canSelectExecutionTarget;

  const heteroType = agencyConfig?.heterogeneousProvider?.type;
  const boundDeviceId = agencyConfig?.boundDeviceId;
  const isHetero = !!heteroType;
  const supportsSandbox = isHeterogeneousSandboxExecutionAvailable(heteroType);

  const {
    data: devices,
    error: deviceListError,
    isConfirmed: isDeviceListConfirmed,
    isValidating: isDeviceListValidating,
    mutate: refreshDevices,
  } = useDeviceList();

  useElectronStore((s) => s.useFetchGatewayDeviceInfo)();
  const gatewayDeviceInfo = useElectronStore((s) => s.gatewayDeviceInfo);
  const currentDeviceId = isDesktop ? gatewayDeviceInfo?.deviceId : undefined;
  const [reconnectingDeviceId, setReconnectingDeviceId] = useState<string>();

  const handleReconnectDevice = useCallback(
    async (deviceId: string) => {
      setReconnectingDeviceId(deviceId);
      try {
        if (isDesktop && deviceId === currentDeviceId) {
          await useElectronStore.getState().connectGateway();
        } else {
          window.location.href = `lobehub://device/reconnect?deviceId=${encodeURIComponent(deviceId)}`;
        }

        let connected = false;
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const nextDevices = await refreshDevices();
          if (nextDevices?.some((device) => device.deviceId === deviceId && device.online)) {
            connected = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (!connected) toast.error(t('heteroAgent.executionTarget.reconnectFailed'));
      } catch (error) {
        console.error('Device reconnect failed:', error);
        toast.error(t('heteroAgent.executionTarget.reconnectFailed'));
      } finally {
        setReconnectingDeviceId(undefined);
      }
    },
    [currentDeviceId, refreshDevices, t],
  );

  const deviceRoutingAvailable = useIsGatewayModeEnabled(agentId);
  const executionTarget = resolveExecutionTarget(agencyConfig, {
    clientExecutionAvailable: isDesktop,
    deviceRoutingAvailable,
    isHetero,
    workspaceScoped,
  });
  const chipExecutionTarget = canShowExecutionTargetSelector
    ? executionTarget
    : (agencyConfig?.executionTarget ?? executionTarget);

  useEffect(() => {
    if (!canShowExecutionTargetSelector) return;
    if (supportsSandbox) return;
    if (isWorkspacePreferenceLoading) return;
    if (executionTarget !== 'none') return;
    setOpen(true);
  }, [
    canShowExecutionTargetSelector,
    executionTarget,
    isWorkspacePreferenceLoading,
    supportsSandbox,
  ]);

  const localSandboxEnabled = isLocalSandboxEnabled(agencyConfig, executionTarget);
  const localSandboxNetwork = agencyConfig?.localSandboxNetwork === true;
  const { data: sandboxCapability, mutate: revalidateSandboxCapability } =
    useLocalSandboxCapability();
  const canUseLocalSandbox = sandboxCapability?.available === true;

  useEffect(() => {
    if (!isDesktop || !open) return;
    void revalidateSandboxCapability();
  }, [open, revalidateSandboxCapability]);

  const selectExecutionTarget = useSelectExecutionTarget(agentId);
  const { selectTarget, topicDeviceId } = useTopicAwareTargetSelect({
    agentId,
    currentDeviceId,
    devices,
    selectExecutionTarget,
    topicId,
  });

  const [isInstallingSandbox, setIsInstallingSandbox] = useState(false);
  const handleInstallSandbox = useCallback(async () => {
    setIsInstallingSandbox(true);
    try {
      const result = await localFileService.installSandbox();
      await revalidateSandboxCapability(result.capability, { revalidate: false });
    } finally {
      setIsInstallingSandbox(false);
    }
  }, [revalidateSandboxCapability]);

  const handleToggleSandboxNetwork = useSandboxNetworkToggle({
    agentId,
    deviceRoutingAvailable,
    isHetero,
    selectExecutionTarget,
  });

  useEffect(() => {
    if (!isDesktop) return;
    if (!canShowExecutionTargetSelector) return;
    if (isWorkspacePreferenceLoading) return;
    if (agencyConfig?.executionTarget !== undefined) return;
    if (agencyConfig?.boundDeviceId !== undefined) return;
    if (!currentDeviceId) return;
    void selectExecutionTarget('local', undefined, { silent: true });
  }, [
    agencyConfig?.executionTarget,
    agencyConfig?.boundDeviceId,
    currentDeviceId,
    canShowExecutionTargetSelector,
    isWorkspacePreferenceLoading,
  ]);

  const desktopDownload = useDesktopDownload();

  const boundDevice =
    canShowExecutionTargetSelector && executionTarget === 'device'
      ? devices?.find((device) => device.deviceId === boundDeviceId)
      : undefined;

  const { personal, privateWorkspace, workspace } = groupExecutionTargetDevices(devices);
  const privateDevices = isWorkspaceAgent ? privateWorkspace : [];
  const workspaceDevices = isWorkspaceAgent ? workspace : [];
  const personalOnlyDevices = isWorkspaceAgent ? [] : personal;
  const showDeviceGroups = isWorkspaceAgent;
  const deviceRows = devicePoolForAgent(devices, isWorkspaceAgent);
  const poolStatus = getDevicePoolStatus({
    error: deviceListError,
    isConfirmed: isDeviceListConfirmed,
    isValidating: isDeviceListValidating,
    rowCount: deviceRows.length,
  });
  const isPoolEmpty = poolStatus === 'empty';
  const showWebDownloadCard =
    DESKTOP_APP_ENABLED &&
    desktopDownload.available &&
    !isDesktop &&
    !isWorkspaceAgent &&
    isPoolEmpty;
  const showWorkspaceEnrollHint = isWorkspaceAgent && isPoolEmpty;
  const showHeaderDownloadLink =
    DESKTOP_APP_ENABLED && desktopDownload.available && !isDesktop && !showWebDownloadCard;

  const isActive = (target: DeviceExecutionTarget, deviceId?: string) => {
    if (target === 'device') return executionTarget === 'device' && boundDeviceId === deviceId;
    if (target === 'local') return executionTarget === 'local' && !localSandboxEnabled;
    return executionTarget === target;
  };

  return {
    agentWorkspaceId,
    boundDevice,
    boundDeviceId,
    canShowExecutionTarget,
    canShowExecutionTargetSelector,
    canUseLocalSandbox,
    chipExecutionTarget,
    cliBin: CLI_PRIMARY_BIN,
    currentDeviceId,
    desktopDownload,
    deviceRows,
    executionTarget,
    handleInstallSandbox,
    handleReconnectDevice,
    handleToggleSandboxNetwork,
    heteroType,
    isActive,
    isHetero,
    isInstallingSandbox,
    isPoolEmpty,
    isWorkspaceAgent,
    localSandboxEnabled,
    localSandboxNetwork,
    open,
    personalOnlyDevices,
    poolStatus,
    privateDevices,
    reconnectingDeviceId,
    refreshDevices,
    sandboxCapability,
    selectTarget,
    setOpen,
    showDesktopDownload: DESKTOP_APP_ENABLED && desktopDownload.available && !isDesktop,
    showDeviceGroups,
    showHeaderDownloadLink,
    showWebDownloadCard,
    showWorkspaceEnrollHint,
    supportsSandbox,
    topicDeviceId,
    topicDeviceUnknown,
    workspaceDevices,
  };
};

export type ExecutionTargetController = ReturnType<typeof useExecutionTargetController>;

/** Tags passed into a device row. Kept here so both menus tag the same way. */
export const deviceRowTags = (
  active: boolean,
  topicTag: ReactNode | undefined,
  base: ReactNode[],
): ReactNode[] => (active && topicTag ? [...base, topicTag] : base);

export type ExecutionDevice = DeviceListItem;
