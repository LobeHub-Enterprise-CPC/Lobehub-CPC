import type { TenantMigrator } from '@lobechat/database/tenant';
import { getTenantMigrators } from '@lobechat/database/tenant';
import { describe, expect, it, vi } from 'vitest';

const distributionMigrator: TenantMigrator = {
  journalTables: ['__drizzle_distribution_migrations'],
  name: 'distribution',
  run: vi.fn(),
};

// A distribution overrides the business slot to register its chain.
vi.mock('@lobechat/business-tenant', () => ({
  registerBusinessTenantMigrators: (register: (migrator: TenantMigrator) => void) =>
    register(distributionMigrator),
}));

describe('PostgresTenantDatabaseExecutor tenant migrators', () => {
  it('loads the business slot chains after the OSS chain', async () => {
    await import('../postgresExecutor');

    expect(getTenantMigrators().map((migrator) => migrator.name)).toEqual([
      'lobehub',
      'distribution',
    ]);
  });
});
