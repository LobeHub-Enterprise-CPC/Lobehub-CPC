import { DEFAULT_AVATAR } from '@lobechat/const';

/**
 * A member Agent's avatar, falling back to the same default every other surface
 * shows for an Agent without one, so a Channel does not draw it differently
 * from the sidebar.
 */
export const getMemberAvatar = (member?: { config: { avatar?: string | null } }) =>
  member?.config.avatar || DEFAULT_AVATAR;
