import { randomUUID } from 'node:crypto';

import IORedis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetRedisClient } from '@/server/modules/Redis';

import { tenantDiscovery } from './tenantDiscovery';

const url = process.env.TEST_DISCOVERY_REDIS_URL;
const prefix = `td-w1-${randomUUID()}`;
vi.mock('@/envs/redis', () => ({
  getRedisConfig: () => ({
    enabled: !!process.env.TEST_DISCOVERY_REDIS_URL,
    url: process.env.TEST_DISCOVERY_REDIS_URL ?? '',
    prefix,
    tls: false,
  }),
}));
let inspect: IORedis;
const keys = () => inspect.keys(`${prefix}:*`);
beforeAll(() => {
  if (url) inspect = new IORedis(url);
});
beforeEach(async () => {
  if (!url) return;
  vi.spyOn(Date, 'now').mockReturnValue(60_001);
  const existing = await keys();
  if (existing.length) await inspect.del(...existing);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  if (!url) return;
  const own = await keys();
  if (own.length) await inspect.del(...own);
  await resetRedisClient();
  await inspect.quit();
});

describe.skipIf(!url)('tenantless discovery admission on isolated real Redis', () => {
  it('sets expiry on first INCR only and keeps concurrent counters exact', async () => {
    await tenantDiscovery.admit('select', '192.0.2.1');
    const ipKey = (await keys()).find((key) => key.includes('select:ip:192.0.2.1'))!;
    expect(await inspect.ttl(ipKey)).toBeGreaterThan(0);
    await inspect.expire(ipKey, 41);
    await tenantDiscovery.admit('select', '192.0.2.1');
    expect(await inspect.ttl(ipKey)).toBeLessThanOrEqual(41);
    await Promise.all(
      Array.from({ length: 20 }, () => tenantDiscovery.admit('select', '192.0.2.1')),
    );
    expect(await inspect.get(ipKey)).toBe('22');
  });

  it('rejects IP/email locally before consuming global budget', async () => {
    for (let i = 0; i < 10; i++)
      expect(await tenantDiscovery.admit('discovery', '192.0.2.2', `hmac-${i}`)).toBeNull();
    expect(await tenantDiscovery.admit('discovery', '192.0.2.2', 'other')).toBe(60);
    const global = (await keys()).find((key) => key.includes('discovery:global'))!;
    expect(await inspect.get(global)).toBe('10');
    for (let i = 0; i < 5; i++)
      expect(await tenantDiscovery.admit('discovery', `192.0.3.${i}`, 'same-hmac')).toBeNull();
    expect(await tenantDiscovery.admit('discovery', '192.0.3.10', 'same-hmac')).toBe(60);
    expect(await inspect.get(global)).toBe('15');
    expect((await keys()).some((key) => key.includes('@'))).toBe(false);
  });

  it('rotates fixed-window keys and enforces deployment-wide select budget', async () => {
    for (let i = 0; i < 600; i++) await tenantDiscovery.admit('select', `client-${i}`);
    expect(await tenantDiscovery.admit('select', 'next-client')).toBe(60);
    vi.mocked(Date.now).mockReturnValue(120_001);
    expect(await tenantDiscovery.admit('select', 'next-client')).toBeNull();
    expect((await keys()).some((key) => key.endsWith(':2'))).toBe(true);
  });

  it('stores immutable desktop snapshots for 600 seconds without refreshing TTL or overwriting a racing winner', async () => {
    const hash = 'a'.repeat(64);
    const a = {
      tenantId: 'tenant-a',
      entry: 'https://a.example.com',
      name: 'Acme',
      endpointVersion: 3,
      codeChallenge: 'a'.repeat(43),
      expiresAt: Date.now() + 600000,
    };
    const b = { ...a, tenantId: 'tenant-b', entry: 'https://b.example.com', endpointVersion: 4 };
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        tenantDiscovery.putDesktopSelection(hash, i % 2 ? a : b),
      ),
    );
    const stored = await tenantDiscovery.getDesktopSelection(hash);
    expect(results.every((value) => JSON.stringify(value) === JSON.stringify(stored))).toBe(true);
    const key = (await keys()).find((key) => key.includes(`desktop:${hash}`))!;
    expect(await inspect.ttl(key)).toBeGreaterThanOrEqual(598);
    expect(await inspect.ttl(key)).toBeLessThanOrEqual(600);
    await inspect.expire(key, 41);
    await tenantDiscovery.putDesktopSelection(hash, a);
    expect(await inspect.ttl(key)).toBeLessThanOrEqual(41);
    expect(await tenantDiscovery.getDesktopSelection(hash)).toEqual(stored);
  });

  it('performs atomic non-destructive read/compare and permits retries after a wrong challenge', async () => {
    const hash = 'b'.repeat(64);
    const snapshot = {
      tenantId: 'tenant-a',
      entry: 'https://a.example.com',
      name: 'Acme',
      endpointVersion: 3,
      codeChallenge: 'a'.repeat(43),
      expiresAt: Date.now() + 600000,
    };
    await tenantDiscovery.putDesktopSelection(hash, snapshot);
    expect(await tenantDiscovery.readDesktopHandoff(hash, 'wrong')).toBeNull();
    for (let attempt = 0; attempt < 3; attempt++)
      expect(await tenantDiscovery.readDesktopHandoff(hash, snapshot.codeChallenge)).toEqual(
        snapshot,
      );
    expect(await tenantDiscovery.getDesktopSelection(hash)).toEqual(snapshot);
    const key = (await keys()).find((key) => key.includes(`desktop:${hash}`))!;
    await inspect.expire(key, 1);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await tenantDiscovery.readDesktopHandoff(hash, snapshot.codeChallenge)).toBeNull();
  });

  it('enforces the independent handoff IP budget without writing any database admission counter', async () => {
    for (let i = 0; i < 120; i++)
      expect(await tenantDiscovery.admit('handoff', '192.0.2.99')).toBeNull();
    expect(await tenantDiscovery.admit('handoff', '192.0.2.99')).toBe(60);
    const own = await keys();
    expect(own).toHaveLength(1);
    expect(own[0]).toContain('handoff:ip:');
    expect(own[0]).not.toContain('global');
  });
});
