// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { migrateUnlessReady, runStartupMigrations } from './startup';

const client = () => ({ query: vi.fn().mockResolvedValue({ rows: [] }) });

describe('startup migrations', () => {
  it('isolates a broken tenant and lets healthy tenants finish without failing startup', async () => {
    const report = vi.fn();
    const result = { failed: [{ reason: '42P01', tenantId: 'broken' }], migrated: ['healthy'] };
    await expect(
      runStartupMigrations({
        client: client(),
        migratePlatform: async () => undefined,
        report,
        upgradeTenants: async () => result,
      }),
    ).resolves.toEqual(result);
    expect(report).toHaveBeenCalledWith({
      event: 'tenant_migration_summary',
      ready: 1,
      unavailable: 1,
    });
    expect(report).toHaveBeenCalledWith({
      event: 'tenant_migration_unavailable',
      reason: '42P01',
      tenantId: 'broken',
    });
  });

  it('aborts on platform failure without running tenant upgrades', async () => {
    const upgradeTenants = vi.fn();
    const connection = client();
    await expect(
      runStartupMigrations({
        client: connection,
        migratePlatform: async () => {
          throw new Error('platform failed');
        },
        report: vi.fn(),
        upgradeTenants,
      }),
    ).rejects.toThrow('platform failed');
    expect(upgradeTenants).not.toHaveBeenCalled();
    expect(connection.query).toHaveBeenLastCalledWith(
      'SELECT pg_advisory_unlock($1, $2)',
      [1280262725, 1],
    );
  });

  it('does not migrate an already verified tenant on another start', async () => {
    const migrate = vi.fn().mockResolvedValue(undefined);
    const verify = vi.fn().mockRejectedValueOnce(new Error('pending')).mockResolvedValue(undefined);
    await migrateUnlessReady(verify, migrate);
    await migrateUnlessReady(verify, migrate);
    expect(migrate).toHaveBeenCalledTimes(1);
  });

  it.each(['password=secret', 'UPPER_CASE_CREDENTIAL_SECRET'])(
    'redacts unsafe diagnostic %s',
    async (reason) => {
      const report = vi.fn();
      await runStartupMigrations({
        client: client(),
        migratePlatform: async () => undefined,
        report,
        upgradeTenants: async () => ({
          failed: [{ reason, tenantId: 'broken' }],
          migrated: [],
        }),
      });
      expect(report).toHaveBeenCalledWith({
        event: 'tenant_migration_unavailable',
        reason: 'TENANT_MIGRATION_FAILED',
        tenantId: 'broken',
      });
    },
  );
});
