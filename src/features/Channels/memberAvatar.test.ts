import { DEFAULT_AVATAR } from '@lobechat/const';
import { describe, expect, it } from 'vitest';

import { getMemberAvatar } from './memberAvatar';

describe('getMemberAvatar', () => {
  it("shows the member Agent's own avatar", () => {
    expect(getMemberAvatar({ config: { avatar: '/avatars/sky.svg' } })).toBe('/avatars/sky.svg');
  });

  it('falls back to the default Agent avatar, as the sidebar does', () => {
    expect(getMemberAvatar({ config: {} })).toBe(DEFAULT_AVATAR);
    expect(getMemberAvatar({ config: { avatar: '' } })).toBe(DEFAULT_AVATAR);
    expect(getMemberAvatar(undefined)).toBe(DEFAULT_AVATAR);
    expect(DEFAULT_AVATAR).not.toBe('🤖');
  });
});
