import { isDesktop } from '@lobechat/const';
import type { DeviceListItem } from '@lobechat/types';
import { agentDisplayName, isChannelRuntime } from '@lobechat/types';
import { t } from 'i18next';

import { resolveAgentWorkingDirectory } from '@/helpers/agentWorkingDirectory';
import { resolveExecutionPlan } from '@/helpers/executionTarget';
import { globalAgentContextManager } from '@/helpers/GlobalAgentContextManager';
import { agentService } from '@/services/agent';
import { deviceService } from '@/services/device';
import { gatewayConnectionService } from '@/services/electron/gatewayConnection';
import { getAgentStoreState } from '@/store/agent';
import { getElectronStoreState } from '@/store/electron';

/**
 * Why an Agent cannot join a Channel right now. Mirrors the server's join rules
 * (`apps/server/src/services/channel/members.ts`) plus the device routing this
 * client performs, so the picker can label a row before the user submits.
 */
export type ChannelMemberIssue = 'unsupported' | 'noModel' | 'unrouted' | 'offline' | 'noDirectory';

export interface ChannelMemberCandidate {
  agentId: string;
  deviceId?: string;
  heterogeneous: boolean;
  heteroType?: string;
  /** Present when the Agent is not ready to join; `undefined` means ready. */
  issue?: ChannelMemberIssue;
  name: string;
  workingDirectory?: string;
}

/** A device and working directory the user picked for one member while creating the Channel. */
export interface ChannelMemberEnvironment {
  deviceId: string;
  workingDirectory: string;
}

/** Re-diagnose a device Agent after the user overrides where it should run. */
export function applyChannelEnvironment(
  candidate: ChannelMemberCandidate,
  environment: ChannelMemberEnvironment | undefined,
  devices: Pick<DeviceListItem, 'deviceId' | 'online'>[],
): ChannelMemberCandidate {
  if (!candidate.heterogeneous || !environment?.deviceId) return candidate;
  const deviceId = environment.deviceId;
  const workingDirectory = environment.workingDirectory.trim() || undefined;
  return {
    ...candidate,
    deviceId,
    issue: diagnoseChannelCandidate({
      deviceId,
      deviceOnline: !!devices.find((device) => device.deviceId === deviceId)?.online,
      hasModel: true,
      heteroType: candidate.heteroType,
      workingDirectory,
    }),
    workingDirectory,
  };
}

/** Thrown when the user must fix a selected Agent before the Channel can be saved. */
export class ChannelReadinessError extends Error {
  constructor(
    message: string,
    readonly candidates: ChannelMemberCandidate[],
  ) {
    super(message);
    this.name = 'ChannelReadinessError';
  }
}

/** Runtime support is knowable from the list payload alone, before any config fetch. */
export function isUnsupportedChannelRuntime(heteroType: string | undefined) {
  return !!heteroType && (heteroType === 'native' || !isChannelRuntime(heteroType));
}

export function diagnoseChannelCandidate(input: {
  deviceId?: string;
  deviceOnline: boolean;
  hasModel: boolean;
  heteroType?: string;
  workingDirectory?: string;
}): ChannelMemberIssue | undefined {
  if (!input.heteroType) return input.hasModel ? undefined : 'noModel';
  if (isUnsupportedChannelRuntime(input.heteroType)) return 'unsupported';
  if (!input.deviceId) return 'unrouted';
  if (!input.deviceOnline) return 'offline';
  if (!input.workingDirectory) return 'noDirectory';
  return undefined;
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

export async function resolveChannelCandidates(
  agentIds: string[],
  environments: Record<string, ChannelMemberEnvironment> = {},
) {
  const agents = await Promise.all(
    agentIds.map(async (id) => {
      const agent = await agentService.getAgentConfigById(id);
      if (!agent) throw new Error(t('agentSetupRequired', { ns: 'channel', name: id }));
      return { ...agent, id };
    }),
  );
  const hasHeterogeneous = agents.some((agent) => agent.agencyConfig?.heterogeneousProvider);
  const [devices, currentDeviceId]: [DeviceListItem[], string | undefined] = hasHeterogeneous
    ? await Promise.all([deviceService.listDevices(), resolveCurrentDeviceId()])
    : [[], undefined];
  const context = isDesktop ? globalAgentContextManager.getContext() : undefined;
  const candidates: ChannelMemberCandidate[] = agents.map((agent) => {
    const agencyConfig = agent.agencyConfig;
    const name = agentDisplayName(agent, agent.id);
    if (!agencyConfig?.heterogeneousProvider)
      return {
        agentId: agent.id,
        heterogeneous: false,
        // Same rule the server applies when a native Agent joins.
        issue: diagnoseChannelCandidate({
          deviceOnline: true,
          hasModel: !!agent.model && !!agent.provider,
        }),
        name,
      };
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
    const heteroType = agencyConfig.heterogeneousProvider.type;
    return applyChannelEnvironment(
      {
        agentId: agent.id,
        deviceId,
        heterogeneous: true,
        heteroType,
        issue: diagnoseChannelCandidate({
          deviceId,
          deviceOnline: !!device?.online,
          hasModel: true,
          heteroType,
          workingDirectory,
        }),
        name,
        workingDirectory,
      },
      environments[agent.id],
      devices,
    );
  });
  return { candidates, devices };
}

/**
 * Resolve each existing Agent just as a new standalone conversation would, unless
 * the user picked a different device or directory for it in the create dialog.
 */
export async function resolveChannelSelections(
  agentIds: string[],
  environments: Record<string, ChannelMemberEnvironment> = {},
) {
  const { candidates, devices } = await resolveChannelCandidates(agentIds, environments);
  // Report every blocked Agent at once so the user does not fix them one submit at a time.
  const blocked = candidates.filter((candidate) => candidate.issue);
  if (blocked.length)
    throw new ChannelReadinessError(
      t('agentSetupRequired', {
        ns: 'channel',
        name: blocked.map((candidate) => candidate.name).join(', '),
      }),
      blocked,
    );
  const members = candidates.map((candidate) =>
    candidate.heterogeneous
      ? {
          agentId: candidate.agentId,
          deviceId: candidate.deviceId,
          workingDirectory: candidate.workingDirectory,
        }
      : { agentId: candidate.agentId },
  );
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
