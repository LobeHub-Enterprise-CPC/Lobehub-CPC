import type { ChannelJobState } from '@lobechat/types';

import type { channelService } from '@/services/channel';

type Detail = Awaited<ReturnType<typeof channelService.detail>>;
export type ActivityState = Extract<
  ChannelJobState,
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
  | 'unavailable'
>;

const ACTIVITY_STATES: ReadonlySet<ChannelJobState> = new Set<ActivityState>([
  'queued',
  'paused',
  'starting',
  'typing',
  'running',
  'awaiting_approval',
  'stop_requested',
  'execution_unknown',
  'failed',
  'offline',
  'unavailable',
]);
const isActivity = (state: ChannelJobState): state is ActivityState => ACTIVITY_STATES.has(state);

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
        jobs.find(
          (item) => item.messageId === latest?.id && ['cancelled', 'failed'].includes(item.status),
        );
      // Settled outcomes (replied, cancelled, ...) are receipts, not live activity.
      if (!job || !isActivity(job.state)) return [];
      return [{ memberId: member.id, name: member.name, state: job.state }];
    });
}
