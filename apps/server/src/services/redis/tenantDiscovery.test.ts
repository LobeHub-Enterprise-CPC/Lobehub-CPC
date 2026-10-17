import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSharedRedisServiceClient } from './client';
import { tenantDiscovery } from './tenantDiscovery';

const client = vi.hoisted(() => ({ eval: vi.fn() }));
vi.mock('./client', () => ({ getSharedRedisServiceClient: vi.fn(async () => client) }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSharedRedisServiceClient).mockResolvedValue(client as never);
});
afterEach(() => vi.useRealTimers());
describe('tenant discovery rate limits', () => {
  it('admits without any tenant scope through the shared client', async () => {
    client.eval.mockResolvedValue(1);
    await expect(tenantDiscovery.admit('discovery', '192.0.2.1', 'hmac')).resolves.toBeNull();
  });
  it('rejects a locally limited IP without spending global budget', async () => {
    client.eval.mockResolvedValue(11);
    await expect(tenantDiscovery.admit('discovery', '192.0.2.1', 'hmac')).resolves.toBeGreaterThan(
      0,
    );
    expect(client.eval).toHaveBeenCalledTimes(1);
  });
  it('rejects a limited mailbox without spending global budget', async () => {
    client.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(6);
    expect(await tenantDiscovery.admit('discovery', '192.0.2.1', 'hmac')).toBeGreaterThan(0);
    expect(client.eval).toHaveBeenCalledTimes(2);
  });
  it('applies deployment-wide and select budgets and rotates fixed-window keys', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(60_001);
    client.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(601);
    expect(await tenantDiscovery.admit('select', '192.0.2.1')).toBe(60);
    const keys = client.eval.mock.calls.map((call) => call[2]);
    expect(keys).toEqual([
      'tenant-discovery:select:ip:192.0.2.1:1',
      'tenant-discovery:select:global:1',
    ]);
    vi.setSystemTime(120_001);
    client.eval.mockResolvedValue(1);
    await tenantDiscovery.admit('select', '192.0.2.1');
    expect(client.eval.mock.lastCall?.[2]).toBe('tenant-discovery:select:global:2');
  });
  it('uses an independent 120/IP handoff budget without a global database counter', async () => {
    client.eval.mockResolvedValueOnce(120).mockResolvedValueOnce(121);
    await expect(tenantDiscovery.admit('handoff', '192.0.2.1')).resolves.toBeNull();
    expect(await tenantDiscovery.admit('handoff', '192.0.2.1')).toBeGreaterThan(0);
    expect(client.eval).toHaveBeenCalledTimes(2);
    expect(client.eval.mock.calls.every((call) => call[2].includes(':handoff:ip:'))).toBe(true);
  });
  it('fails closed when Redis is disabled or fails', async () => {
    vi.mocked(getSharedRedisServiceClient).mockResolvedValueOnce(null);
    await expect(tenantDiscovery.admit('discovery', 'unknown')).rejects.toThrow(
      'REDIS_UNAVAILABLE',
    );
    client.eval.mockRejectedValueOnce(new Error('offline'));
    await expect(tenantDiscovery.admit('select', 'unknown')).rejects.toThrow('offline');
  });
});
