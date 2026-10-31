// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as HatchetConfig from '@/server/modules/Hatchet/config';

const mocks = vi.hoisted(() => ({
  agentServices: [] as { args: unknown[]; executeStep: ReturnType<typeof vi.fn> }[],
  asyncToolSweep: vi.fn(),
  deliveryProbe: async () => 'none' as const,
  forEachTenant: vi.fn(),
  getOperationMetadata: vi.fn(),
  hatchetDelivery: false,
  sweep: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: async () => 'tenant-db' }));
vi.mock('@/server/modules/Hatchet/config', async (importOriginal) => ({
  ...(await importOriginal<typeof HatchetConfig>()),
  isHatchetDeliveryEnabled: () => mocks.hatchetDelivery,
}));
vi.mock('@/server/modules/Hatchet/probe', () => ({
  createHatchetDeliveryProbe: () => mocks.deliveryProbe,
}));
vi.mock('@/server/modules/AgentRuntime', () => ({
  AgentRuntimeCoordinator: class {
    getOperationMetadata = mocks.getOperationMetadata;
  },
}));
vi.mock('@/server/modules/Tenant/fanOut', () => ({ forEachTenant: mocks.forEachTenant }));
vi.mock('@/server/services/agentRuntime', () => ({
  StaleOperationReaper: class {
    constructor(
      readonly db: unknown,
      readonly options: unknown,
    ) {}
    sweep = () => mocks.sweep(this.db, this.options);
  },
}));
vi.mock('@/server/services/agentRuntime/AsyncToolResumeReconciler', () => ({
  AsyncToolResumeReconciler: class {
    constructor(
      readonly db: unknown,
      readonly options: unknown,
    ) {}
    sweep = () => mocks.asyncToolSweep(this.db, this.options);
  },
}));
vi.mock('@/server/services/agentRuntime/SubAgentBridgeReconciler', () => ({
  SubAgentBridgeReconciler: class {
    sweep = () => mocks.reconcile();
  },
}));
vi.mock('@/server/services/aiAgent', () => ({
  AiAgentService: class {
    executeStep = vi.fn(async () => ({}));
    constructor(...args: unknown[]) {
      mocks.agentServices.push({ args, executeStep: this.executeStep });
    }
  },
}));

const { LocalQueueServiceImpl } = await import('@/server/services/queue/impls');
const { createRedriveQueue, reapOperationsForAllTenants } = await import('../reapOperations');
const { default: app } = await import('../index');

const sweepResult = {
  abandoned: 0,
  examined: 3,
  failed: 0,
  redriven: 1,
  skipped: 2,
  skippedReasons: { delivery_active: 1, delivery_unknown: 1, no_state: 0 },
};
const idleAsyncToolResume = { confirmed: 0, examined: 0, exhausted: 0, failed: 0, republished: 0 };
const idleReconciliation = { errors: 0, failed: 0, processed: 0, recovered: 0, skipped: 0 };

/** The fan-out as it runs: tenant after tenant, a tenant that threw recorded as failed. */
const fanOutOver =
  (tenantIds: string[]) => async (_job: string, operation: (id: string) => Promise<unknown>) => {
    const succeeded = [];
    const failed = [];
    for (const tenantId of tenantIds) {
      try {
        succeeded.push({ tenantId, result: await operation(tenantId) });
      } catch {
        failed.push({ tenantId, reason: 'Error' });
      }
    }
    return { succeeded, failed };
  };

const respond = async () =>
  (await reapOperationsForAllTenants({
    json: (body: unknown, status: number) => ({ body, status }),
  } as never)) as unknown as { body: Record<string, unknown>; status: number };

describe('stale-operation cron sweep', () => {
  beforeEach(() => {
    mocks.hatchetDelivery = false;
    mocks.sweep.mockReset().mockResolvedValue(sweepResult);
    mocks.asyncToolSweep.mockReset().mockResolvedValue(idleAsyncToolResume);
    mocks.reconcile.mockReset().mockResolvedValue(idleReconciliation);
    mocks.forEachTenant.mockReset();
  });

  it('requires the cron bearer secret', async () => {
    vi.stubEnv('CRON_SECRET', 'cron-secret');
    const denied = await app.request('/api/cron/agent/reap-operations', { method: 'POST' });
    expect(denied.status).toBe(401);
    expect(mocks.forEachTenant).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('sweeps every tenant with its own database and reports a failed tenant as 5xx', async () => {
    mocks.forEachTenant.mockImplementation(async (_job, operation) => ({
      failed: [{ reason: 'TENANT_UNAVAILABLE', tenantId: 'tenant-b' }],
      succeeded: [{ result: await operation('tenant-a'), tenantId: 'tenant-a' }],
    }));

    const response = await respond();

    expect(mocks.sweep).toHaveBeenCalledWith(
      'tenant-db',
      expect.objectContaining({ queueService: expect.anything() }),
    );
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      examined: 3,
      redriven: 1,
      reconciliation: idleReconciliation,
      skippedReasons: { delivery_active: 1, delivery_unknown: 1 },
    });
  });

  it('runs reconciliation after the reaper and reports a reconciler that threw as 5xx', async () => {
    const order: string[] = [];
    mocks.sweep.mockImplementation(async () => {
      order.push('reaper');
      return sweepResult;
    });
    mocks.reconcile
      .mockImplementationOnce(async () => {
        order.push('reconcile');
        throw new Error('unavailable');
      })
      .mockImplementationOnce(async () => {
        order.push('reconcile');
        return { ...idleReconciliation, processed: 1, recovered: 1 };
      });
    mocks.forEachTenant.mockImplementation(fanOutOver(['tenant-a', 'tenant-b']));

    const response = await respond();

    expect(order).toEqual(['reaper', 'reconcile', 'reaper', 'reconcile']);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      // The reaper's totals of the tenant whose reconciliation threw are kept.
      examined: 6,
      reconciliation: { processed: 1, recovered: 1 },
      failedTenants: [{ phase: 'subAgentBridge', reason: 'Error', tenantId: 'tenant-a' }],
    });
  });

  it('runs both reconcilers for every tenant in Hatchet mode and reports their totals', async () => {
    mocks.hatchetDelivery = true;
    mocks.asyncToolSweep.mockResolvedValue({
      confirmed: 1,
      examined: 3,
      exhausted: 1,
      failed: 1,
      republished: 1,
    });
    mocks.reconcile.mockResolvedValue({
      errors: 1,
      failed: 0,
      processed: 2,
      recovered: 1,
      skipped: 0,
    });
    mocks.forEachTenant.mockImplementation(fanOutOver(['tenant-a', 'tenant-b']));

    const response = await respond();

    expect(mocks.asyncToolSweep).toHaveBeenCalledTimes(2);
    expect(mocks.asyncToolSweep).toHaveBeenCalledWith(
      'tenant-db',
      expect.objectContaining({
        deliveryProbe: mocks.deliveryProbe,
        queueService: expect.anything(),
      }),
    );
    expect(mocks.reconcile).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      asyncToolResume: { confirmed: 2, examined: 6, exhausted: 2, failed: 2, republished: 2 },
      reconciliation: { errors: 2, failed: 0, processed: 4, recovered: 2, skipped: 0 },
    });
  });

  it('keeps the reaper totals and still runs the bridge sweep when the async-tool sweep throws', async () => {
    mocks.hatchetDelivery = true;
    const order: string[] = [];
    mocks.sweep.mockImplementation(async () => {
      order.push('reaper');
      return sweepResult;
    });
    mocks.asyncToolSweep
      .mockImplementationOnce(async () => {
        order.push('asyncToolResume');
        throw Object.assign(new Error('listing failed'), { code: '57P01' });
      })
      .mockImplementationOnce(async () => {
        order.push('asyncToolResume');
        return idleAsyncToolResume;
      });
    mocks.reconcile.mockImplementation(async () => {
      order.push('subAgentBridge');
      return { ...idleReconciliation, processed: 1, recovered: 1 };
    });
    mocks.forEachTenant.mockImplementation(fanOutOver(['tenant-a', 'tenant-b']));

    const response = await respond();

    expect(order).toEqual([
      'reaper',
      'asyncToolResume',
      'subAgentBridge',
      'reaper',
      'asyncToolResume',
      'subAgentBridge',
    ]);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      examined: 6,
      redriven: 2,
      reconciliation: { processed: 2, recovered: 2 },
      failedTenants: [{ phase: 'asyncToolResume', reason: '57P01', tenantId: 'tenant-a' }],
    });
  });

  it.each([
    [true, mocks.deliveryProbe],
    [false, undefined],
  ])('asks Hatchet before redriving only in Hatchet delivery mode (%s)', async (enabled, probe) => {
    mocks.hatchetDelivery = enabled;
    mocks.forEachTenant.mockImplementation(fanOutOver(['tenant-a']));

    await respond();

    const [, options] = mocks.sweep.mock.calls[0] as [unknown, { deliveryProbe?: unknown }];
    expect(options.deliveryProbe).toBe(probe);
    // The async-tool resume reconciler exists only for Hatchet delivery.
    expect(mocks.asyncToolSweep).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(mocks.reconcile).toHaveBeenCalledOnce();
  });

  it('runs a local-mode redrive in-process as the operation owner, in its workspace', async () => {
    const setCallback = vi.spyOn(LocalQueueServiceImpl.prototype, 'setExecutionCallback');
    expect(createRedriveQueue().getImpl()).toBeInstanceOf(LocalQueueServiceImpl);
    mocks.getOperationMetadata.mockResolvedValue({ userId: 'user-1', workspaceId: 'ws-1' });

    const callback = setCallback.mock.calls.at(-1)![0];
    await callback('op-1', 3, { phase: 'tool_result' }, { approvedToolCall: 'call-1' });

    expect(mocks.agentServices.at(-1)?.args).toEqual([
      'tenant-db',
      'user-1',
      { includeShareVisitor: false, workspaceId: 'ws-1' },
    ]);
    expect(mocks.agentServices.at(-1)?.executeStep).toHaveBeenCalledWith({
      approvedToolCall: 'call-1',
      context: { phase: 'tool_result' },
      operationId: 'op-1',
      stepIndex: 3,
    });
  });
});
