import { getSharedRedisServiceClient } from './client';

const WINDOW_SECONDS = 60;
export const DISCOVERY_LIMITS = {
  discovery: { global: 300, ip: 10, unknown: 30, email: 5 },
  select: { global: 600, ip: 30, unknown: 30 },
  // Trusted-backend lookups (/api/internal/tenant-discovery/lookup): same buckets as public discovery,
  // separate key prefix so integration traffic cannot exhaust the public budget.
  integration: { global: 600, ip: 10, unknown: 30, email: 5 },
  handoff: { ip: 120, unknown: 120 },
} as const;

// Only the first increment sets expiry: a crashed process cannot leave an immortal counter.
const INCREMENT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;
export interface DesktopSelectionSnapshot {
  codeChallenge: string;
  endpointVersion: number;
  entry: string;
  expiresAt: number;
  name: string;
  tenantId: string;
}
const readJson = (raw: string | null): unknown => {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { invalidSnapshot: true };
  }
};
const desktopKey = (stateHash: string) => {
  if (!/^[a-f0-9]{64}$/.test(stateHash)) throw new Error('DESKTOP_HANDOFF_KEY_INVALID');
  return `tenant-discovery:desktop:${stateHash}`;
};
// A wrong challenge is not destructive. The same valid reader can retry until the original TTL.
const READ_HANDOFF = `local value = redis.call('GET', KEYS[1])
if not value then return nil end
local ok, snapshot = pcall(cjson.decode, value)
if not ok or type(snapshot) ~= 'table' then return '{}' end
if snapshot.codeChallenge ~= ARGV[1] then return nil end
return value`;
const requireClient = async () => {
  const redis = await getSharedRedisServiceClient();
  if (!redis) throw new Error('REDIS_UNAVAILABLE');
  return redis;
};
export const tenantDiscovery = {
  /**
   * Every kind counts the IP bucket; `discovery` and `integration` also count the mailbox bucket,
   * and all but `handoff` count the global bucket.
   */
  async admit(
    kind: 'discovery' | 'select' | 'handoff' | 'integration',
    ip: string,
    emailHash?: string,
  ) {
    const redis = await requireClient();
    const now = Date.now();
    const window = Math.floor(now / (WINDOW_SECONDS * 1000));
    const retryAfter = WINDOW_SECONDS - (Math.floor(now / 1000) % WINDOW_SECONDS);
    const count = (key: string) =>
      redis.eval<number>(
        INCREMENT,
        1,
        `tenant-discovery:${kind}:${key}:${window}`,
        WINDOW_SECONDS * 2,
      );
    const limits = DISCOVERY_LIMITS[kind];
    if ((await count(`ip:${ip}`)) > (ip === 'unknown' ? limits.unknown : limits.ip))
      return retryAfter;
    if (kind === 'handoff') return null;
    if (
      (kind === 'discovery' || kind === 'integration') &&
      emailHash &&
      (await count(`email:${emailHash}`)) > DISCOVERY_LIMITS[kind].email
    )
      return retryAfter;
    if ((await count('global')) > DISCOVERY_LIMITS[kind].global) return retryAfter;
    return null;
  },
  async getDesktopSelection(stateHash: string): Promise<unknown> {
    const redis = await requireClient();
    return readJson(await redis.get(desktopKey(stateHash)));
  },
  async putDesktopSelection(
    stateHash: string,
    snapshot: DesktopSelectionSnapshot,
  ): Promise<unknown> {
    const redis = await requireClient();
    const key = desktopKey(stateHash);
    const written = await redis.set(key, JSON.stringify(snapshot), { nx: true, ex: 600 });
    return written === 'OK' ? snapshot : readJson(await redis.get(key));
  },
  async readDesktopHandoff(stateHash: string, codeChallenge: string): Promise<unknown> {
    const redis = await requireClient();
    const value = await redis.eval<string | null>(
      READ_HANDOFF,
      1,
      desktopKey(stateHash),
      codeChallenge,
    );
    return readJson(value);
  },
};
