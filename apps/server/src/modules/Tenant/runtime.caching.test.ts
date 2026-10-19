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
    let connectionVersion = 1;
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
              connectionVersion,
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
    let now = 1000;
    const verify = vi.fn(async () => {});
    const runtime = new TenantRuntime(
      () => ({ select }) as never,
      pools as never,
      () => new Date(now),
      new TenantClaims(),
      verify,
    );
    const { scope, release } = await runtime.enterTenantId('t-1');
    try {
      const reads = select.mock.calls.length;
      for (let n = 0; n < 10; n++) await scope.session.database.execute(sql`SELECT 1`);
      expect(select).toHaveBeenCalledTimes(reads);
      now += 5001;
      const next = await runtime.enterTenantId('t-1');
      await next.release();
      expect(verify).toHaveBeenCalledTimes(1);
      runtime.invalidate('t-1');
      await (await runtime.enterTenantId('t-1')).release();
      expect(verify).toHaveBeenCalledTimes(2);
      connectionVersion += 1;
      now += 5001;
      await (await runtime.enterTenantId('t-1')).release();
      expect(verify).toHaveBeenCalledTimes(3);
      connectionVersion += 1;
      now += 5001;
      verify.mockRejectedValueOnce(new Error('verification failed'));
      await expect(runtime.enterTenantId('t-1')).rejects.toMatchObject({
        code: 'TENANT_NOT_READY',
      });
      await (await runtime.enterTenantId('t-1')).release();
      expect(verify).toHaveBeenCalledTimes(5);
      connectionVersion += 1;
      now += 5001;
      verify.mockImplementationOnce(async () => {
        now += 5001;
      });
      await expect(runtime.enterTenantId('t-1')).rejects.toMatchObject({
        code: 'TENANT_UNAVAILABLE',
      });
      await (await runtime.enterTenantId('t-1')).release();
      expect(verify).toHaveBeenCalledTimes(7);
      const readsBeforeFreeze = select.mock.calls.length;
      desiredState = 'frozen';
      runtime.invalidate('t-1');
      await expect(scope.session.database.execute(sql`SELECT 1`)).rejects.toMatchObject({
        cause: { code: 'TENANT_FROZEN' },
      });
      expect(select).toHaveBeenCalledTimes(readsBeforeFreeze + 1);
    } finally {
      await release();
    }
  });
});
