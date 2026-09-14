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
  vi.stubEnv('ENABLE_CHANNEL', '1');
  vi.stubEnv('CHANNEL_ALLOWED_USER_IDS', 'other, owner ');
  getUserPreference.mockResolvedValue({ lab: { enableChannel: true } });
});
afterEach(() => vi.unstubAllEnvs());

describe('Channel Labs gate', () => {
  it.each([undefined, {}, { lab: {} }, { lab: { enableChannel: false } }])(
    'rejects an allowlisted account without explicit opt-in: %j',
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

  it.each([
    ['0', 'owner'],
    ['1', ''],
    ['1', 'owner-other'],
  ])('preserves deployment restrictions (%s, %s)', async (enabled, allowed) => {
    vi.stubEnv('ENABLE_CHANNEL', enabled);
    vi.stubEnv('CHANNEL_ALLOWED_USER_IDS', allowed);
    expect(await isChannelEnabled(db, 'owner')).toBe(false);
    expect(getUserPreference).not.toHaveBeenCalled();
  });
});
