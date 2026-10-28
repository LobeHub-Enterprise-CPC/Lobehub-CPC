import type { ChannelJobState } from '@lobechat/types';

import type { channelService } from '@/services/channel';

export type ChannelDetail = Awaited<ReturnType<typeof channelService.detail>>;
type Job = ChannelDetail['jobs'][number];
type Run = ChannelDetail['runs'][number];
export type ReceiptState = ChannelJobState;

export interface MemberReceipt {
  accepted: boolean;
  environment: Run['executionConfig'];
  error?: string | null;
  hasReply: boolean;
  member: ChannelDetail['members'][number];
  pending: boolean;
  request: ChannelDetail['messages'][number];
  state: ReceiptState;
}

export interface ChannelReceipts {
  byMember: Map<string, MemberReceipt[]>;
  byMessage: Map<string, MemberReceipt[]>;
}

/** Derive recipients from durable jobs, never from today's roster, mentions or thread followers. */
export function buildChannelReceipts(data: ChannelDetail): ChannelReceipts {
  const byMessage = new Map<string, MemberReceipt[]>();
  const byMember = new Map<string, MemberReceipt[]>();
  const runs = new Map(data.runs.map((run) => [run.jobId, run]));
  const members = new Map(data.members.map((member) => [member.id, member]));
  const requests = new Map(
    [...data.contextMessages, ...data.messages]
      .filter((message) => !message.authorMemberId)
      .map((message) => [message.id, message]),
  );
  const groups = new Map<string, Map<string, Job[]>>();
  for (const job of data.jobs) {
    const request = requests.get(job.messageId);
    if (!request || request.threadId !== job.threadId || !members.has(job.memberId)) continue;
    const group = groups.get(job.messageId) || new Map<string, Job[]>();
    group.set(job.memberId, [...(group.get(job.memberId) || []), job]);
    groups.set(job.messageId, group);
  }
  for (const [messageId, group] of groups) {
    const request = requests.get(messageId)!;
    const receipts: MemberReceipt[] = [];
    for (const [memberId, jobs] of group) {
      const member = members.get(memberId)!;
      jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      // An isolated writer keeps its unconfirmed outcome on this request, but it no longer
      // occupies the member, so it is neither the current job nor pending work.
      const holdsWriter = (run?: Run) => !!run && !run.writerReleased && !run.isolatedAt;
      const current =
        jobs.find((job) => holdsWriter(runs.get(job.id))) ||
        jobs.find((job) => ['queued', 'running'].includes(job.status)) ||
        jobs[0];
      const run = runs.get(current.id);
      const hasReply = jobs.some((job) => !!runs.get(job.id)?.publishedMessageId);
      // The server derives display state once; clients never re-derive it from raw run flags.
      let state = current.state;
      if (hasReply && ['yielded', 'completed'].includes(state)) state = 'replied';
      const receipt: MemberReceipt = {
        accepted: jobs.some((job) => runs.get(job.id)?.acceptance === 'accepted'),
        environment: run?.executionConfig ?? null,
        error: run?.error ?? current.blockedReason,
        hasReply,
        member,
        pending:
          ['queued', 'running'].includes(current.status) ||
          holdsWriter(run) ||
          (!run?.isolatedAt &&
            ['stop_requested', 'execution_unknown', 'publishing'].includes(state)),
        request,
        state,
      };
      receipts.push(receipt);
      byMember.set(memberId, [...(byMember.get(memberId) || []), receipt]);
    }
    // Keep a stable order as agents move from queued to running to completed.
    receipts.sort((a, b) => data.members.indexOf(a.member) - data.members.indexOf(b.member));
    byMessage.set(messageId, receipts);
  }
  for (const receipts of byMember.values())
    receipts.sort((a, b) => b.request.sequence - a.request.sequence);
  return { byMember, byMessage };
}

export function isQuietReceipt(receipt: MemberReceipt) {
  return (
    !receipt.pending &&
    ['replied', 'yielded', 'completed', 'cancelled', 'held'].includes(receipt.state)
  );
}

/** Active work in any thread wins over newer queued requests; old outcomes do not imply presence. */
export function memberCurrentReceipt(receipts: MemberReceipt[]) {
  const active = receipts.filter((receipt) => receipt.pending);
  return (
    active.find((receipt) =>
      ['awaiting_approval', 'execution_unknown', 'stop_requested'].includes(receipt.state),
    ) ||
    active.find((receipt) =>
      ['starting', 'running', 'typing', 'publishing'].includes(receipt.state),
    ) ||
    active[0]
  );
}
