// @vitest-environment node
import { EventEmitter } from 'node:events';

import { SUPPORTED_TENANT_SCHEMA_VERSIONS, tenantDbNames } from '@lobechat/database/tenant';
import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { TenantClaims } from './claims';
import { TenantRuntime } from './runtime';

vi.mock('./endpoints', () => ({ loadTenantPublicEndpoint: async () => ({}) }));
vi.mock('@/server/crypto/tenantKeys', () => ({ openDirectoryData: () => 'test-password' }));

describe('tenant business SQL admission cache', () => {
  it('reuses lifecycle facts across real session statements and rejects after Console invalidation', async () => {
    const names = tenantDbNames('t-1');
    let desiredState = 'active';
    const select = vi.fn(() => {
      const query = {
        from: () => query,
        leftJoin: () => query,
        where: () => query,
        limit: async () => [
          {
            directory: {
              ...names,
              tenantId: 't-1',
              slug: 'test',
              status: 'active',
              schemaVersion: [...SUPPORTED_TENANT_SCHEMA_VERSIONS][0],
              connectionVersion: 1,
              credentialBundleVersion: 1,
              runtimeSecret: 'test-envelope',
              database: 'unused',
              host: 'unused',
              port: 1,
              tls: { enabled: false },
            },
            lifecycle: { acceptedVersion: 1, desiredState, expiresAt: null, freezeReasons: [] },
          },
        ],
      };
      return query;
    });
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      release: vi.fn(),
    });
    const pools = { acquire: () => ({ pool: { connect: async () => client }, release: () => {} }) };
    const runtime = new TenantRuntime(
      () => ({ select }) as never,
      pools as never,
      () => new Date(1000),
      new TenantClaims(),
      async () => {},
    );
    const { scope, release } = await runtime.enterTenantId('t-1');
    try {
      const reads = select.mock.calls.length;
      for (let n = 0; n < 10; n++) await scope.session.database.execute(sql`SELECT 1`);
      expect(select).toHaveBeenCalledTimes(reads);
      desiredState = 'frozen';
      runtime.invalidate('t-1');
      await expect(scope.session.database.execute(sql`SELECT 1`)).rejects.toMatchObject({
        cause: { code: 'TENANT_FROZEN' },
      });
      expect(select).toHaveBeenCalledTimes(reads + 1);
    } finally {
      await release();
    }
  });
});
