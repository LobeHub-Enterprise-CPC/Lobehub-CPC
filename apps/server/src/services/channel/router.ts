import type { ChannelModel } from '@/database/models/channel';

/** Recover requests saved by older clients before transactional audience delivery. */
export async function routeChannelMessage(
  model: ChannelModel,
  channelId: string,
  messageId: string,
) {
  const input = await model.routingInput(channelId, messageId);
  if (!input) return;
  await model.assign(channelId, messageId, {
    memberIds: input.members.map((member) => member.id),
    reason: input.members.length ? 'All active members' : 'No active members',
  });
}
