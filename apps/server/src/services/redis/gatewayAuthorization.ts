import { requireTenantScope } from '@lobechat/database/tenant';

import { getRedisConfig } from '@/envs/redis';
import { initializeRedis } from '@/server/modules/Redis';
import type {
  GatewayAttemptRecord,
  GatewayAuthorizationRecord,
  GatewayOIDCProjection,
} from '@/server/services/gatewayAuthorization/types';
import { GatewayAuthorizationError } from '@/server/services/gatewayAuthorization/wire';

const client = async () => {
  requireTenantScope();
  const config = getRedisConfig();
  const redis = config.enabled ? await initializeRedis(config) : null;
  if (!redis) throw new GatewayAuthorizationError('GATEWAY_AUTHORITY_UNAVAILABLE', 503);
  return redis;
};
const key = (kind: string, id: string) => `gateway:v1:${kind}:${encodeURIComponent(id)}`;
const read = async <T>(kind: string, id: string): Promise<T | null> => {
  const raw = await (await client()).get(key(kind, id));
  return raw ? (JSON.parse(raw) as T) : null;
};
const write = async (kind: string, id: string, record: unknown, expiresAt: number) => {
  const remaining = Math.floor(expiresAt - Date.now());
  if (remaining <= 0) throw new GatewayAuthorizationError('UNAUTHORIZED');
  const written = await (
    await client()
  ).set(key(kind, id), JSON.stringify(record), { nx: true, px: remaining });
  if (written !== 'OK') throw new GatewayAuthorizationError('ATTEMPT_CONFLICT', 409);
};
const CAS = `local raw = redis.call('GET', KEYS[1])
if raw ~= ARGV[1] then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
return 1`;
const RENEW = `local raw = redis.call('GET', KEYS[1])
if raw ~= ARGV[1] or tonumber(ARGV[3]) <= 0 then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1`;
export const gatewayAuthorization = {
  getAuthorization: (id: string) => read<GatewayAuthorizationRecord>('authorization', id),
  putAuthorization: (id: string, record: GatewayAuthorizationRecord) =>
    write('authorization', id, record, record.authRecordExpiresAt),
  async renewAuthorization(previous: GatewayAuthorizationRecord, next: GatewayAuthorizationRecord) {
    const renewed = await (
      await client()
    ).eval<number>(
      RENEW,
      1,
      key('authorization', previous.authorizationId),
      JSON.stringify(previous),
      JSON.stringify(next),
      Math.floor(next.authRecordExpiresAt - Date.now()),
    );
    if (renewed !== 1) throw new GatewayAuthorizationError('SOURCE_UNVERIFIABLE');
  },
  async revokeAuthorization(id: string) {
    await (await client()).del(key('authorization', id));
  },
  getOIDCProjection: (jti: string) => read<GatewayOIDCProjection>('oidc', jti),
  putOIDCProjection: (jti: string, record: GatewayOIDCProjection) =>
    write('oidc', jti, record, record.accessTokenExpiresAt),
  getAttempt: (id: string) => read<GatewayAttemptRecord>('attempt', id),
  putAttempt: (record: GatewayAttemptRecord) =>
    write('attempt', record.intent.attemptId, record, record.intent.attemptExpiresAt),
  async compareAttempt(previous: GatewayAttemptRecord, next: GatewayAttemptRecord) {
    return (
      (await (
        await client()
      ).eval<number>(
        CAS,
        1,
        key('attempt', previous.intent.attemptId),
        JSON.stringify(previous),
        JSON.stringify(next),
      )) === 1
    );
  },
  async interruptOperation(operationId: string) {
    const redis = await client();
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        key('attempt', '*').replace('%2A', '*'),
        'COUNT',
        100,
      );
      cursor = next;
      for (const attemptKey of keys) {
        const raw = await redis.get(attemptKey);
        if (!raw) continue;
        const record = JSON.parse(raw) as GatewayAttemptRecord;
        if (
          record.intent.operationId !== operationId ||
          !['prepared', 'claimed'].includes(record.state)
        )
          continue;
        const state = record.state === 'claimed' ? 'executionUnknown' : 'cancelledBeforeDispatch';
        await redis.eval(CAS, 1, attemptKey, raw, JSON.stringify({ ...record, state }));
      }
    } while (cursor !== '0');
  },
};
