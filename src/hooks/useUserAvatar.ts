import { useAppAssetUrl } from '@lobechat/business-tenant/client';
import { DEFAULT_USER_AVATAR } from '@lobechat/const';

import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';

export const useUserAvatar = () => {
  const avatar = useUserStore(userProfileSelectors.userAvatar) || DEFAULT_USER_AVATAR;

  return useAppAssetUrl(avatar);
};
