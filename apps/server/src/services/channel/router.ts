import type { ChannelModel } from '@/database/models/channel';

import { channelRuleAudience, evaluateChannelAudience } from './speaker';

/** Jev is worker-side opt-in; otherwise retain the legacy audience without a provider call. */
export async function routeChannelMessage(
  model: ChannelModel,
  channelId: string,
  messageId: string,
) {
  const input = await model.routingInput(channelId, messageId);
  if (!input) return;
  const decision =
    process.env.CHANNEL_ROUTER === 'jev'
      ? await evaluateChannelAudience(input)
      : {
          memberIds: channelRuleAudience(input),
          reason: 'Legacy audience (Jev disabled)',
          diagnostics: { source: 'rules' },
        };
  await model.assign(channelId, messageId, decision, input.attemptId);
}
