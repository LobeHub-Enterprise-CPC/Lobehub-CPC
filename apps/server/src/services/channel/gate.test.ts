// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isChannelEnabled } from './gate';

const { flags } = vi.hoisted(() => ({
  flags: { current: {} as Record<string, boolean | string[]> },
}));
vi.mock('@/server/featureFlags', () => ({
  getServerFeatureFlagsFromRuntimeConfig: async () => flags.current,
}));

beforeEach(() => {
  vi.stubEnv('CHANNEL_GATEWAY_URL', 'http://channel-worker:3211');
  flags.current = { channel: true };
});
afterEach(() => vi.unstubAllEnvs());

describe('Channel gateway gate', () => {
  it('enables Channels without an account preference', async () => {
    expect(await isChannelEnabled('owner')).toBe(true);
  });

  it.each(['', 'not-a-url'])('preserves gateway restrictions (%s)', async (gateway) => {
    vi.stubEnv('CHANNEL_GATEWAY_URL', gateway);
    // A legacy boolean must not accidentally enable an unconfigured service.
    vi.stubEnv('ENABLE_CHANNEL', '1');
    expect(await isChannelEnabled('owner')).toBe(false);
  });

  it('disables Channels for users the channel flag is off for', async () => {
    flags.current = { channel: false };
    expect(await isChannelEnabled('owner')).toBe(false);

    flags.current = { channel: ['someone-else'] };
    expect(await isChannelEnabled('owner')).toBe(false);

    flags.current = { channel: ['owner'] };
    expect(await isChannelEnabled('owner')).toBe(true);
  });
});
