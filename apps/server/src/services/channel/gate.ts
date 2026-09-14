import { UserModel } from '@/database/models/user';
import type { LobeChatDatabase } from '@/database/type';

/** Deployment access and an explicit, persisted Labs opt-in are both required. */
export const isChannelEnabled = async (db: LobeChatDatabase, ownerId: string) => {
  if (
    process.env.ENABLE_CHANNEL !== '1' ||
    !(process.env.CHANNEL_ALLOWED_USER_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .includes(ownerId)
  )
    return false;

  const preference = await new UserModel(db, ownerId).getUserPreference();
  return preference?.lab?.enableChannel === true;
};
