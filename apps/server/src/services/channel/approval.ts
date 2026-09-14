import { setTimeout as delay } from 'node:timers/promises';

import type { ChatToolPayload } from '@lobechat/types';
import { CHANNEL_LIMITS } from '@lobechat/types';

import type { ChannelModel } from '@/database/models/channel';

export async function waitForChannelApproval(input: {
  channelId: string;
  fence: number;
  model: ChannelModel;
  runId: string;
  signal: AbortSignal;
  tool: ChatToolPayload;
}) {
  const id = `${input.runId}:${input.tool.id}`;
  const deadline = new Date(Date.now() + CHANNEL_LIMITS.approvalMs);
  while (true) {
    input.signal.throwIfAborted();
    const approval = await input.model.requestApproval(
      input.channelId,
      input.runId,
      input.fence,
      id,
      { tool: input.tool },
      deadline,
    );
    if (approval.expiresAt.getTime() <= Date.now()) throw new Error('Channel approval expired');
    if (approval.decision) {
      if (approval.decision !== 'approved') throw new Error('Channel tool approval rejected');
      await input.model.resumeAfterApproval(input.channelId, input.runId, input.fence);
      return;
    }
    await delay(2000, undefined, { signal: input.signal });
  }
}
