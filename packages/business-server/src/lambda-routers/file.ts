import { sql } from 'drizzle-orm';

import type { FileExternalReferenceGuard } from '@/database/models/file';
import { channelMessages } from '@/database/privateSchemas/channel';
import type { Transaction } from '@/database/type';

export interface BusinessFileUploadCheckParams {
  actualSize: number;
  clientIp?: string;
  inputSize: number;
  transaction?: Transaction;
  url: string;
  userId: string;
  workspaceId?: string | null;
}

export async function businessFileUploadCheck(
  _params: BusinessFileUploadCheckParams,
): Promise<void> {}

export interface BusinessFileTransferStorageCheckParams {
  additionalSize: number;
  targetUserId: string;
  targetWorkspaceId: string | null;
}

export async function businessFileTransferStorageCheck(
  _params: BusinessFileTransferStorageCheckParams,
): Promise<void> {}

/**
 * Private-schema file reference hook. The catalog probe keeps OSS databases, which do not
 * install Channel tables, on the no-op path without treating a feature flag as evidence.
 */
export const businessFileExternalReferenceGuard: FileExternalReferenceGuard = async (
  trx: Transaction,
  fileId: string,
) => {
  const table = await trx.execute<{ exists: boolean }>(sql`
    SELECT to_regclass('public.channel_messages') IS NOT NULL AS exists
  `);
  if (!table.rows[0]?.exists) return false;

  const [reference] = await trx
    .select({ id: channelMessages.id })
    .from(channelMessages)
    .where(sql`${channelMessages.fileIds} @> ${JSON.stringify([fileId])}::jsonb`)
    .limit(1);
  return Boolean(reference);
};
