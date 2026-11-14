import { fileEnv } from '@/envs/file';
import { FileS3 } from '@/server/modules/S3';
import { redisService } from '@/server/services/redis';

/** Deletes every object under the tenant's storage root; nothing to do without object storage. */
export const purgeTenantObjects = async (tenantId: string): Promise<number> =>
  fileEnv.S3_BUCKET ? new FileS3().deleteTenantObjects(tenantId) : 0;

/**
 * What a destroyed tenant leaves outside its database: uploaded files and trace snapshots in
 * object storage, cache and agent runtime state in Redis. Removed before `unregister` records
 * completion, so a failure leaves the phase open and the same request repeats it.
 */
export const purgeTenantResidue = async (tenantId: string) => {
  await Promise.all([purgeTenantObjects(tenantId), redisService.tenantResidue.purge(tenantId)]);
};
