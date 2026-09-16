import { UserModel } from '@/database/models/user';
import type { LobeChatDatabase } from '@/database/type';

import { getChannelGatewayUrl } from './gateway';

/** A configured gateway and an explicit, persisted Labs opt-in are both required. */
export const isChannelEnabled = async (db: LobeChatDatabase, ownerId: string) => {
  if (!getChannelGatewayUrl()) return false;

  const preference = await new UserModel(db, ownerId).getUserPreference();
  return preference?.lab?.enableChannel === true;
};
