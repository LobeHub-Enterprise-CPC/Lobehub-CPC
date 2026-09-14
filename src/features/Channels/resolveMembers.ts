import { isDesktop } from '@lobechat/const';
import { agentDisplayName } from '@lobechat/types';
import { t } from 'i18next';

import { resolveAgentWorkingDirectory } from '@/helpers/agentWorkingDirectory';
import { resolveExecutionPlan } from '@/helpers/executionTarget';
import { globalAgentContextManager } from '@/helpers/GlobalAgentContextManager';
import { agentService } from '@/services/agent';
import { deviceService } from '@/services/device';
import { gatewayConnectionService } from '@/services/electron/gatewayConnection';
import { getAgentStoreState } from '@/store/agent';
import { getElectronStoreState } from '@/store/electron';

export interface ChannelMemberCandidate {
  agentId: string;
  deviceId?: string;
  heterogeneous: boolean;
  name: string;
  workingDirectory?: string;
}

/**
 * This desktop's own gateway device id. The Electron store only learns it once a
 * chat-input component mounts `useFetchGatewayDeviceInfo`, so a Channel opened
 * straight after launch asks the main process directly instead of treating an
 * unbound `local` Agent as having no device.
 */
async function resolveCurrentDeviceId() {
  if (!isDesktop) return undefined;
  const cached = getElectronStoreState().gatewayDeviceInfo?.deviceId;
  if (cached) return cached;
  try {
    return (await gatewayConnectionService.getDeviceInfo())?.deviceId;
  } catch {
    return undefined;
  }
}

export async function resolveChannelCandidates(agentIds: string[]) {
  const agents = await Promise.all(
    agentIds.map(async (id) => {
      const agent = await agentService.getAgentConfigById(id);
      if (!agent) throw new Error(t('agentSetupRequired', { ns: 'channel', name: id }));
      return { ...agent, id };
    }),
  );
  const hasHeterogeneous = agents.some((agent) => agent.agencyConfig?.heterogeneousProvider);
  const [devices, currentDeviceId] = hasHeterogeneous
    ? await Promise.all([deviceService.listDevices(), resolveCurrentDeviceId()])
    : [[], undefined];
  const context = isDesktop ? globalAgentContextManager.getContext() : undefined;
  const candidates: ChannelMemberCandidate[] = agents.map((agent) => {
    const agencyConfig = agent.agencyConfig;
    const name = agentDisplayName(agent, agent.id);
    if (!agencyConfig?.heterogeneousProvider)
      return { agentId: agent.id, heterogeneous: false, name };
    const plan = resolveExecutionPlan({
      agencyConfig,
      clientExecutionAvailable: true,
      isHetero: true,
      localDeviceId: currentDeviceId,
      onlineDeviceIds: devices.filter((device) => device.online).map((device) => device.deviceId),
    });
    const deviceId =
      plan.kind === 'device'
        ? plan.deviceId
        : agencyConfig.executionTarget === 'device'
          ? agencyConfig.boundDeviceId
          : undefined;
    const device = devices.find((item) => item.deviceId === deviceId);
    const workingDirectory = resolveAgentWorkingDirectory({
      agencyConfig: { ...agencyConfig, boundDeviceId: deviceId, executionTarget: 'device' },
      currentDeviceId,
      deviceDefaultCwd: device?.defaultCwd ?? undefined,
      fallback:
        deviceId === currentDeviceId ? (context?.desktopPath ?? context?.homePath) : undefined,
      legacyAgentWorkingDirectory:
        deviceId && deviceId === currentDeviceId
          ? getAgentStoreState().localAgentWorkingDirectoryMap[agent.id]
          : undefined,
    });
    return { agentId: agent.id, deviceId, heterogeneous: true, name, workingDirectory };
  });
  return { candidates, devices };
}

/** Resolve each existing Agent just as a new standalone conversation would. */
export async function resolveChannelSelections(agentIds: string[]) {
  const { candidates, devices } = await resolveChannelCandidates(agentIds);
  const members = candidates.map((candidate) => {
    if (!candidate.heterogeneous) return { agentId: candidate.agentId };
    const device = devices.find((item) => item.deviceId === candidate.deviceId);
    if (!candidate.deviceId || !device?.online || !candidate.workingDirectory)
      throw new Error(t('agentSetupRequired', { ns: 'channel', name: candidate.name }));
    return {
      agentId: candidate.agentId,
      deviceId: candidate.deviceId,
      workingDirectory: candidate.workingDirectory,
    };
  });
  // As with standalone run start, register resolved cwd roots without changing Agent bindings.
  for (const device of devices) {
    const paths = members
      .filter((member) => member.deviceId === device.deviceId)
      .map((member) => member.workingDirectory!);
    const missing = [...new Set(paths)].filter(
      (path) => path !== device.defaultCwd && !device.workingDirs?.some((dir) => dir.path === path),
    );
    if (missing.length)
      await deviceService.updateDevice({
        deviceId: device.deviceId,
        workingDirs: [...missing.map((path) => ({ path })), ...(device.workingDirs ?? [])].slice(
          0,
          20,
        ),
      });
  }
  return members;
}
