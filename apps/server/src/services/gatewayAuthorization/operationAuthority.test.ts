// @vitest-environment node
import type { PlatformDatabase } from '@lobechat/database/platform';
import {
  runWithTenantScope,
  type TenantPoolManager,
  type TenantScope,
} from '@lobechat/database/tenant';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as tenantRuntime from '@/server/modules/Tenant/runtime';

import { assertGatewayVersion } from './index';
import { assertGatewayStateExecution, isGatewayStateExecutionCurrent } from './operationAuthority';

const operation = vi.hoisted(() => ({
  read: vi.fn(),
}));
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: async () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: operation.read }) }) }),
  }),
}));

describe('operation execution authority', () => {
  let runtime: tenantRuntime.TenantRuntime;
  let version: number;
  let state: string;
  let platformError: Error | undefined;
  let rows: 'active' | 'missing' | 'destroyed' | 'not-ready';
  const select = vi.fn();
  const execution = { tenantId: 't-1', sourceAcceptedVersion: 1 };
  const run = <T>(fn: () => T) =>
    runWithTenantScope({ tenantId: 't-1', acceptedVersion: 1 } as TenantScope, fn);

  beforeEach(() => {
    vi.useFakeTimers();
    version = 1;
    state = 'active';
    rows = 'active';
    platformError = undefined;
    select.mockReset().mockImplementation(() => {
      const query = {
        from: () => query,
        leftJoin: () => query,
        where: () => query,
        limit: async () => {
          if (platformError) throw platformError;
          return rows === 'missing'
            ? []
            : [
                {
                  directory: {
                    status: rows === 'not-ready' ? 'pending' : 'active',
                    tenantId: 't-1',
                  },
                  lifecycle: {
                    acceptedVersion: version,
                    desiredState: state,
                    expiresAt: null,
                    freezeReasons: [],
                  },
                  destruction: rows === 'destroyed' ? 't-1' : null,
                },
              ];
        },
      };
      return query;
    });
    runtime = new tenantRuntime.TenantRuntime(
      () => ({ select }) as unknown as PlatformDatabase,
      {} as TenantPoolManager,
    );
    vi.spyOn(tenantRuntime, 'getTenantRuntime').mockReturnValue(runtime);
    operation.read.mockReset().mockResolvedValue([{ metadata: execution }]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shares bounded platform snapshots across concurrent steps and refreshes after five seconds', async () => {
    const verify = () => run(() => isGatewayStateExecutionCurrent('op-1', execution));
    expect(await Promise.all(Array.from({ length: 80 }, verify))).toEqual(
      Array.from({ length: 80 }).fill(true),
    );
    expect(select).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await verify()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await verify()).toBe(true);
    expect(select).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    version = 2;
    expect(await verify()).toBe(false);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('does not reuse an expired snapshot when refreshing it fails', async () => {
    await expect(run(() => isGatewayStateExecutionCurrent('op-1', execution))).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    platformError = new Error('platform unavailable');
    await expect(
      run(() => isGatewayStateExecutionCurrent('op-1', execution)),
    ).rejects.toMatchObject({
      code: 'TENANT_UNAVAILABLE',
      source: 'infrastructure',
    });
    platformError = undefined;
    version = 2;
    await expect(run(() => isGatewayStateExecutionCurrent('op-1', execution))).resolves.toBe(false);
  });

  it('keeps normal gateway checks strict and sees invalidation inside the poll cache window', async () => {
    await run(() => isGatewayStateExecutionCurrent('op-1', execution));
    await run(() => assertGatewayVersion('t-1', 1));
    await run(() => assertGatewayStateExecution('op-1', execution));
    expect(select).toHaveBeenCalledTimes(3);
    state = 'frozen';
    runtime.invalidate('t-1');
    await expect(run(() => isGatewayStateExecutionCurrent('op-1', execution))).resolves.toBe(false);
    expect(select).toHaveBeenCalledTimes(4);
  });

  it('propagates tenant database read errors instead of declaring revoked authority', async () => {
    operation.read.mockRejectedValueOnce(new Error('tenant database unavailable'));
    await expect(run(() => isGatewayStateExecutionCurrent('op-1', execution))).rejects.toThrow(
      'tenant database unavailable',
    );
  });

  it.each(['missing', 'destroyed', 'not-ready'] as const)(
    'marks an explicit %s directory refusal as admission for the watcher and step poll',
    async (kind) => {
      rows = kind;
      const code = {
        'missing': 'TENANT_NOT_FOUND',
        'destroyed': 'TENANT_DESTROYED',
        'not-ready': 'TENANT_NOT_READY',
      }[kind];
      await expect(runtime.assertAdmitted('t-1', 0)).rejects.toMatchObject({
        code,
        source: 'admission',
      });
      await expect(runtime.gatewayAdmission('t-1')).rejects.toMatchObject({
        code,
        source: 'admission',
      });
      await expect(run(() => isGatewayStateExecutionCurrent('op-1', execution))).resolves.toBe(
        false,
      );
    },
  );
});
