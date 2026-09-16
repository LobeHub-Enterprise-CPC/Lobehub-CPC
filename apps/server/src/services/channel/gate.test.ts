// @vitest-environment node
import type { UserPreference } from '@lobechat/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

import { isChannelEnabled } from './gate';

const { getUserPreference, constructor } = vi.hoisted(() => ({
  constructor: vi.fn(),
  getUserPreference: vi.fn(),
}));
vi.mock('@/database/models/user', () => ({
  UserModel: class {
    constructor(...args: unknown[]) {
      constructor(...args);
    }
    getUserPreference = getUserPreference;
  },
}));

const db = {} as LobeChatDatabase;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CHANNEL_GATEWAY_URL', 'http://channel-worker:3211');
  getUserPreference.mockResolvedValue({ lab: { enableChannel: true } });
});
afterEach(() => vi.unstubAllEnvs());

describe('Channel Labs gate', () => {
  it.each([undefined, {}, { lab: {} }, { lab: { enableChannel: false } }])(
    'rejects an account without explicit opt-in: %j',
    async (preference: UserPreference | undefined) => {
      getUserPreference.mockResolvedValue(preference);
      expect(await isChannelEnabled(db, 'owner')).toBe(false);
    },
  );

  it('reads the correct owner and does not cache an opt-in after it is disabled', async () => {
    expect(await isChannelEnabled(db, 'owner')).toBe(true);
    expect(constructor).toHaveBeenCalledWith(db, 'owner');
    getUserPreference.mockResolvedValue({ lab: { enableChannel: false } });
    expect(await isChannelEnabled(db, 'owner')).toBe(false);
  });

  it.each(['owner', 'other-user', 'new-user'])('allows any opted-in user: %s', async (ownerId) => {
    expect(await isChannelEnabled(db, ownerId)).toBe(true);
    expect(constructor).toHaveBeenCalledWith(db, ownerId);
  });

  it.each(['', 'not-a-url'])('preserves gateway restrictions (%s)', async (gateway) => {
    vi.stubEnv('CHANNEL_GATEWAY_URL', gateway);
    // A legacy boolean must not accidentally enable an unconfigured service.
    vi.stubEnv('ENABLE_CHANNEL', '1');
    expect(await isChannelEnabled(db, 'owner')).toBe(false);
    expect(getUserPreference).not.toHaveBeenCalled();
  });
});
