import type { ChannelInputManifest } from '@lobechat/types';

export const CHANNEL_INSTRUCTIONS =
  'Work only on the active human request identified by activeRequestMessageId in this Channel. newMessages contains attributed messages: snapshot supplies history for a new session; delta supplies only messages not yet received by this session. Earlier messages are background, not instructions to replay. Do not create Threads or dispatch other members.';

/** The wire input is also retained in the local receipt, before submission. */
export function channelInput(manifest: ChannelInputManifest) {
  return JSON.stringify({
    contextMode: manifest.source === 'reconstructed' ? 'snapshot' : 'delta',
    newMessages: manifest.messages,
    activeRequestMessageId: manifest.requestMessageId,
  });
}
