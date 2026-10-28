import './serverTestConfig';

import type { LobeChatDatabase } from '@lobechat/database';
import {
  requireTenantScope,
  runWithTenantScope,
  type TenantScope,
} from '@lobechat/database/tenant';
import { it } from 'vitest';

import { TenantClaims } from '@/server/modules/Tenant/claims';

export const testTenantClaims = new TenantClaims();

/** In-memory admission boundary: the queue, operation rows and version checks stay real. */
export const testTenantRuntime = {
  assertAdmitted: async () => {},
  enterTenantId: async (tenantId: string) => {
    const scope = requireTenantScope();
    if (scope.tenantId !== tenantId) throw new Error('Unexpected test tenant');
    return { scope, release: await testTenantClaims.enter(tenantId) };
  },
  gatewayAdmission: async (tenantId: string) => {
    const scope = requireTenantScope();
    if (scope.tenantId !== tenantId) throw new Error('Unexpected test tenant');
    return {
      tenantId,
      acceptedVersion: scope.acceptedVersion,
      effectiveState: 'active',
      checkedAt: Date.now(),
      leaseExpiresAt: Date.now() + 30_000,
    };
  },
};

export const runWithTestTenant = async <T>(
  getDatabase: () => LobeChatDatabase,
  run: () => Promise<T>,
) => {
  const scope = {
    tenantId: 'tenant-agent-integration',
    acceptedVersion: 1,
    slug: 'acme',
    endpoint: { basePath: '/orgs/acme', publicUrl: 'http://test.invalid/orgs/acme', version: 1 },
    // Resolve the database provisioned by this test file, including queued continuations.
    session: {
      get database() {
        return getDatabase();
      },
    },
  } as TenantScope;
  const release = await testTenantClaims.enter(scope.tenantId);
  try {
    return await runWithTenantScope(scope, run);
  } finally {
    await release();
  }
};

/** Wrap the test callback itself: fixture use() does not propagate AsyncLocalStorage. */
export const tenantTest = (getDatabase: () => LobeChatDatabase): typeof it => {
  const wrap = (test: typeof it): typeof it =>
    new Proxy(test, {
      apply(target, thisArg, args: unknown[]) {
        const callback = args[1];
        if (typeof callback === 'function') {
          args[1] = (...values: unknown[]) =>
            runWithTestTenant(getDatabase, () => callback(...values));
        }
        return Reflect.apply(target, thisArg, args);
      },
      get(target, property, receiver) {
        if (property === 'each')
          return (...values: unknown[]) => wrap(Reflect.apply(target.each, target, values));
        return Reflect.get(target, property, receiver);
      },
    });
  return wrap(it);
};
