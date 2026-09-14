import type { channelService } from '@/services/channel';

type Detail = Awaited<ReturnType<typeof channelService.detail>>;
export type ActivityState =
  | 'queued'
  | 'paused'
  | 'starting'
  | 'typing'
  | 'running'
  | 'awaiting_approval'
  | 'stop_requested'
  | 'execution_unknown'
  | 'failed'
  | 'offline'
  | 'unavailable';

/** Execution state is scoped to a conversation; old errors must not linger over new requests. */
export function channelActivity(data: Detail, threadId: string | null) {
  const latest = [...data.contextMessages, ...data.messages]
    .filter((message) => !message.authorMemberId && message.threadId === threadId)
    .sort((a, b) => b.sequence - a.sequence)[0];
  return data.members
    .filter((member) => member.active)
    .flatMap((member) => {
      const jobs = data.jobs.filter(
        (job) => job.memberId === member.id && job.threadId === threadId,
      );
      const job =
        jobs.find((item) =>
          data.runs.some((run) => run.jobId === item.id && !run.writerReleased),
        ) ||
        jobs.find((item) => item.status === 'running') ||
        jobs.find((item) => item.status === 'queued') ||
        jobs.find((item) => item.messageId === latest?.id && item.status === 'failed');
      if (!job) return [];
      const run = data.runs.find((item) => item.jobId === job.id);
      // Cancellation may surface as a failed runtime result. Once cleanup is confirmed,
      // it is no longer an active stop request (nor a new error for this discussion).
      if (run?.publicationRevoked && run.writerReleased && run.physicalStopped) return [];
      let state: ActivityState = 'queued';
      if (member.executionPaused && (!run || run.writerReleased)) state = 'paused';
      else if (job.blockedReason)
        state = /DEVICE_OFFLINE|device.*offline/i.test(job.blockedReason)
          ? 'offline'
          : 'unavailable';
      else if (run) {
        if (run.publicationRevoked || run.status === 'stop_requested') state = 'stop_requested';
        else if (
          ['starting', 'running', 'awaiting_approval', 'execution_unknown', 'failed'].includes(
            run.status,
          )
        )
          state = run.status as ActivityState;
        else return [];
      } else if (job.status === 'failed') state = 'failed';
      if (state === 'running' && run?.activity === 'typing') state = 'typing';
      return [{ memberId: member.id, name: member.name, state }];
    });
}
