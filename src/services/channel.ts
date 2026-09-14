import { CHANNEL_PRESENCE } from '@lobechat/types';
import { t } from 'i18next';

import { lambdaClient } from '@/libs/trpc/client';
import { deviceService } from '@/services/device';

export const channelService = {
  validateEnvironment: async (
    input: Parameters<typeof lambdaClient.channel.validateEnvironment.mutate>[0],
  ) => {
    const workingDirectory = input.workingDirectory.trim();
    // Explicitly choosing a root authorizes it before the server/device canonical-path probe.
    // Fetch fresh recents so validating a second member does not overwrite the first one's root.
    const device = (await deviceService.listDevices()).find((d) => d.deviceId === input.deviceId);
    if (!device?.online) throw new Error(t('deviceUnavailable', { ns: 'channel' }));
    if (
      workingDirectory !== device.defaultCwd &&
      !device.workingDirs?.some((d) => d.path === workingDirectory)
    )
      await deviceService.updateDevice({
        deviceId: input.deviceId,
        workingDirs: [{ path: workingDirectory }, ...(device.workingDirs ?? [])].slice(0, 20),
      });
    return lambdaClient.channel.validateEnvironment.mutate({ ...input, workingDirectory });
  },
  pauseMember: (input: Parameters<typeof lambdaClient.channel.pauseMember.mutate>[0]) =>
    lambdaClient.channel.pauseMember.mutate(input),
  resumeMember: (input: Parameters<typeof lambdaClient.channel.resumeMember.mutate>[0]) =>
    lambdaClient.channel.resumeMember.mutate(input),
  updateEnvironment: async (
    input: Parameters<typeof lambdaClient.channel.updateEnvironment.mutate>[0] & {
      agentId: string;
    },
    allowInterruption = false,
  ) => {
    const { agentId, ...memberEnvironment } = input;
    // Reject an invalid destination before interrupting the saved environment.
    const canonical = await channelService.validateEnvironment({
      agentId,
      deviceId: input.deviceId,
      workingDirectory: input.workingDirectory,
    });
    const revision = {
      channelId: input.channelId,
      expectedRevision: input.expectedRevision,
      memberId: input.memberId,
    };
    // The idle check and pause share the claim lock: a newly started task must not
    // be interrupted based on a stale UI snapshot without the user's confirmation.
    const pause = await channelService.pauseMember({ ...revision, onlyIfIdle: !allowInterruption });
    if (pause.confirmationRequired) return pause;

    const deadline = Date.now() + 30_000;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(t('environment.stopTimeout', { ns: 'channel' }));
      const detail = await lambdaClient.channel.page.query(
        { channelId: input.channelId },
        { signal: AbortSignal.timeout(remaining) },
      );
      const member = detail.members.find((item) => item.id === input.memberId);
      if (
        !member?.active ||
        detail.channel.archived ||
        !member.executionPaused ||
        member.environmentRevision !== input.expectedRevision
      )
        throw new Error(t('environment.actionFailed', { ns: 'channel' }));
      const pending = detail.runs.filter(
        (run) => run.memberId === input.memberId && (!run.physicalStopped || !run.writerReleased),
      );
      if (pending.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await lambdaClient.channel.updateEnvironment.mutate({ ...memberEnvironment, ...canonical });
    return { confirmationRequired: false };
  },
  archive: (channelId: string) => lambdaClient.channel.archive.mutate({ channelId }),
  remove: (channelId: string) => lambdaClient.channel.remove.mutate({ channelId }),
  removeMember: (channelId: string, memberId: string) =>
    lambdaClient.channel.removeMember.mutate({ channelId, memberId }),
  addMembers: (input: Parameters<typeof lambdaClient.channel.addMembers.mutate>[0]) =>
    lambdaClient.channel.addMembers.mutate(input),
  resetSession: (channelId: string, memberId: string, threadId: string | null) =>
    lambdaClient.channel.resetSession.mutate({ channelId, memberId, threadId }),
  artifact: (channelId: string, runId: string) =>
    lambdaClient.channel.artifact.query({ channelId, runId }),
  availability: () => lambdaClient.channel.availability.query(),
  list: () => lambdaClient.channel.list.query(),
  detail: (
    channelId: string,
    page: Omit<Parameters<typeof lambdaClient.channel.page.query>[0], 'channelId'> = {},
  ) => lambdaClient.channel.page.query({ channelId, ...page }),
  watch: (
    channelId: string,
    onData: (data: { navigationRevision: string; revision: string }) => void,
    onHealth?: (healthy: boolean) => void,
  ) => {
    let stopped = false;
    let failures = 0;
    let generation = 0;
    let revision: string | undefined;
    let subscription: { unsubscribe: () => void } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reconnect = (ms: number) => {
      clearTimeout(timer);
      if (!stopped && document.visibilityState !== 'hidden') timer = setTimeout(connect, ms);
    };
    const connect = () => {
      if (stopped || document.visibilityState === 'hidden') return;
      const currentGeneration = ++generation;
      const active = () => !stopped && generation === currentGeneration;
      subscription?.unsubscribe();
      subscription = lambdaClient.channel.watch.subscribe(
        { channelId },
        {
          onData: (data) => {
            if (!active()) return;
            failures = 0;
            onHealth?.(true);
            if (data.revision !== revision) {
              revision = data.revision;
              onData(data);
            }
          },
          onComplete: () => {
            if (active()) {
              generation++;
              reconnect(100);
            }
          },
          onError: () => {
            if (!active()) return;
            generation++;
            onHealth?.(false);
            reconnect(
              Math.min(CHANNEL_PRESENCE.retryMs * 2 ** failures++, CHANNEL_PRESENCE.retryMaxMs),
            );
          },
        },
      );
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        generation++;
        clearTimeout(timer);
        subscription?.unsubscribe();
        subscription = undefined;
        onHealth?.(false);
      } else {
        failures = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    connect();
    return {
      unsubscribe: () => {
        stopped = true;
        generation++;
        document.removeEventListener('visibilitychange', onVisibilityChange);
        clearTimeout(timer);
        subscription?.unsubscribe();
      },
    };
  },
  create: (input: Parameters<typeof lambdaClient.channel.create.mutate>[0]) =>
    lambdaClient.channel.create.mutate(input),
  send: (input: Parameters<typeof lambdaClient.channel.send.mutate>[0]) =>
    lambdaClient.channel.send.mutate(input),
  recall: (channelId: string, messageId: string, memberId: string) =>
    lambdaClient.channel.recall.mutate({ channelId, messageId, memberId }),
  branch: (channelId: string, rootMessageId: string) =>
    lambdaClient.channel.branch.mutate({ channelId, rootMessageId }),
  removeThreadFollower: (channelId: string, threadId: string, memberId: string) =>
    lambdaClient.channel.removeThreadFollower.mutate({ channelId, threadId, memberId }),
  retryRouting: (channelId: string, messageId: string) =>
    lambdaClient.channel.retryRouting.mutate({ channelId, messageId }),
  approve: (channelId: string, approvalId: string, approved: boolean) =>
    lambdaClient.channel.approve.mutate({ channelId, approvalId, approved }),
  stop: (channelId: string, scope: { runId: string } | { threadId: string | null }) =>
    lambdaClient.channel.stop.mutate({ channelId, scope }),
};
