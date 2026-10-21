import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getSharedRedisServiceClient } from './client';
import { DISCOVERY_LIMITS, tenantDiscovery } from './tenantDiscovery';

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
  describe('integration kind', () => {
    it('counts ip, mailbox and global buckets under a prefix distinct from public discovery', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(60_001);
      client.eval.mockResolvedValue(1);
      await expect(tenantDiscovery.admit('integration', '192.0.2.1', 'hmac')).resolves.toBeNull();
      expect(client.eval.mock.calls.map((call) => call[2])).toEqual([
        'tenant-discovery:integration:ip:192.0.2.1:1',
        'tenant-discovery:integration:email:hmac:1',
        'tenant-discovery:integration:global:1',
      ]);
    });
    it('limits 10/IP, 30 for unknown IPs, 5/mailbox and 600 globally', async () => {
      client.eval.mockResolvedValueOnce(10).mockResolvedValueOnce(5).mockResolvedValueOnce(600);
      await expect(tenantDiscovery.admit('integration', '192.0.2.1', 'hmac')).resolves.toBeNull();
      client.eval.mockResolvedValueOnce(11);
      expect(await tenantDiscovery.admit('integration', '192.0.2.1', 'hmac')).toBeGreaterThan(0);
      client.eval.mockResolvedValueOnce(30);
      await expect(tenantDiscovery.admit('integration', 'unknown', 'hmac')).resolves.toBeNull();
      client.eval.mockResolvedValueOnce(31);
      expect(await tenantDiscovery.admit('integration', 'unknown', 'hmac')).toBeGreaterThan(0);
      client.eval.mockReset();
      client.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(6);
      expect(await tenantDiscovery.admit('integration', '192.0.2.1', 'hmac')).toBeGreaterThan(0);
      expect(client.eval).toHaveBeenCalledTimes(2);
      client.eval.mockReset();
      client.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValueOnce(601);
      expect(await tenantDiscovery.admit('integration', '192.0.2.1', 'hmac')).toBeGreaterThan(0);
    });
    it('leaves public discovery limits unchanged', () => {
      expect(DISCOVERY_LIMITS.discovery).toEqual({ global: 300, ip: 10, unknown: 30, email: 5 });
      expect(DISCOVERY_LIMITS.select).toEqual({ global: 600, ip: 30, unknown: 30 });
      expect(DISCOVERY_LIMITS.integration).toEqual({ global: 600, ip: 10, unknown: 30, email: 5 });
    });
  });
});
