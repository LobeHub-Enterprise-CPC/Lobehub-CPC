/** Default off. An explicit owner allowlist is required even when enabled. */
export const isChannelEnabled = (ownerId: string) =>
  process.env.ENABLE_CHANNEL === '1' &&
  (process.env.CHANNEL_ALLOWED_USER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .includes(ownerId);
