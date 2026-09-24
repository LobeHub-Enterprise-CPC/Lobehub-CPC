// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isChannelEnabled } from './gate';

beforeEach(() => {
  vi.stubEnv('CHANNEL_GATEWAY_URL', 'http://channel-worker:3211');
});
afterEach(() => vi.unstubAllEnvs());

describe('Channel gateway gate', () => {
  it('enables Channels without an account preference', () => {
    expect(isChannelEnabled()).toBe(true);
  });

  it.each(['', 'not-a-url'])('preserves gateway restrictions (%s)', (gateway) => {
    vi.stubEnv('CHANNEL_GATEWAY_URL', gateway);
    // A legacy boolean must not accidentally enable an unconfigured service.
    vi.stubEnv('ENABLE_CHANNEL', '1');
    expect(isChannelEnabled()).toBe(false);
  });
});
