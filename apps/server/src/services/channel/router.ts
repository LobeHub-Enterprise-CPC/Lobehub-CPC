import type { ChannelModel } from '@/database/models/channel';

import { evaluateChannelAudience } from './speaker';

/** All unmentioned user requests are selected by Jev before any execution jobs are created. */
export async function routeChannelMessage(
  model: ChannelModel,
  channelId: string,
  messageId: string,
) {
  const input = await model.routingInput(channelId, messageId);
  if (!input) return;
  const decision = await evaluateChannelAudience(input);
  await model.assign(channelId, messageId, decision, input.attemptId);
}
