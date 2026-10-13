import { DEFAULT_USER_AVATAR } from '@lobechat/const';

import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';

import { useRemoteAssetUrl } from './useRemoteAssetUrl';

export const useUserAvatar = () => {
  const avatar = useUserStore(userProfileSelectors.userAvatar) || DEFAULT_USER_AVATAR;

  return useRemoteAssetUrl(avatar);
};
