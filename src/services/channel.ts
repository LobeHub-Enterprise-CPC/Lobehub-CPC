import { lambdaClient } from '@/libs/trpc/client';

export const channelService = {
  archive: (channelId: string) => lambdaClient.channel.archive.mutate({ channelId }),
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
  detail: (channelId: string) => lambdaClient.channel.detail.query({ channelId }),
  watch: (
    channelId: string,
    onData: (data: Awaited<ReturnType<typeof lambdaClient.channel.detail.query>>) => void,
  ) => {
    let stopped = false;
    let subscription: { unsubscribe: () => void } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reconnect = (ms: number) => {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(connect, ms);
    };
    const connect = () => {
      if (stopped) return;
      subscription?.unsubscribe();
      subscription = lambdaClient.channel.watch.subscribe(
        { channelId },
        {
          onData,
          onComplete: () => reconnect(100),
          onError: () => reconnect(2000),
        },
      );
    };
    connect();
    return {
      unsubscribe: () => {
        stopped = true;
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
  retryRouting: (channelId: string, messageId: string) =>
    lambdaClient.channel.retryRouting.mutate({ channelId, messageId }),
  approve: (channelId: string, approvalId: string, approved: boolean) =>
    lambdaClient.channel.approve.mutate({ channelId, approvalId, approved }),
  stop: (channelId: string, scope: { runId: string } | { threadId: string | null }) =>
    lambdaClient.channel.stop.mutate({ channelId, scope }),
};
