// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type * as HatchetConfig from '@/server/modules/Hatchet/config';

const mocks = vi.hoisted(() => ({
  agentServices: [] as { args: unknown[]; executeStep: ReturnType<typeof vi.fn> }[],
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
    sweep = vi.fn();
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

describe('stale-operation cron sweep', () => {
  mocks.reconcile.mockResolvedValue({ processed: 0, recovered: 0, failed: 0, skipped: 0 });
  it('requires the cron bearer secret', async () => {
    vi.stubEnv('CRON_SECRET', 'cron-secret');
    const denied = await app.request('/api/cron/agent/reap-operations', { method: 'POST' });
    expect(denied.status).toBe(401);
    expect(mocks.forEachTenant).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('sweeps every tenant with its own database and reports a failed tenant as 5xx', async () => {
    mocks.sweep.mockResolvedValue(sweepResult);
    mocks.forEachTenant.mockImplementation(async (_job, operation) => ({
      failed: [{ reason: 'TENANT_UNAVAILABLE', tenantId: 'tenant-b' }],
      succeeded: [{ result: await operation('tenant-a'), tenantId: 'tenant-a' }],
    }));
    const json = vi.fn((body: unknown, status: number) => ({ body, status }));

    const response = (await reapOperationsForAllTenants({ json } as never)) as unknown as {
      body: Record<string, unknown>;
      status: number;
    };

    expect(mocks.sweep).toHaveBeenCalledWith(
      'tenant-db',
      expect.objectContaining({ queueService: expect.anything() }),
    );
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      examined: 3,
      redriven: 1,
      reconciliation: { processed: 0, recovered: 0, failed: 0, skipped: 0 },
      skippedReasons: { delivery_active: 1, delivery_unknown: 1 },
    });
  });

  it('runs reconciliation after the reaper, with a failing tenant isolated by the fan-out', async () => {
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
        return { processed: 1, recovered: 1, failed: 0, skipped: 0 };
      });
    mocks.forEachTenant.mockImplementation(async (_job, operation) => {
      const succeeded = [];
      const failed = [];
      for (const tenantId of ['tenant-a', 'tenant-b']) {
        try {
          succeeded.push({ tenantId, result: await operation(tenantId) });
        } catch {
          failed.push({ tenantId, reason: 'Error' });
        }
      }
      return { succeeded, failed };
    });
    const json = vi.fn((body: unknown, status: number) => ({ body, status }));
    const response = (await reapOperationsForAllTenants({ json } as never)) as unknown as {
      body: Record<string, unknown>;
      status: number;
    };
    expect(order).toEqual(['reaper', 'reconcile', 'reaper', 'reconcile']);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      reconciliation: { processed: 1, recovered: 1 },
      failedTenants: [{ tenantId: 'tenant-a' }],
    });
    mocks.reconcile.mockResolvedValue({ processed: 0, recovered: 0, failed: 0, skipped: 0 });
  });

  it.each([
    [true, mocks.deliveryProbe],
    [false, undefined],
  ])('asks Hatchet before redriving only in Hatchet delivery mode (%s)', async (enabled, probe) => {
    mocks.hatchetDelivery = enabled;
    mocks.sweep.mockClear().mockResolvedValue(sweepResult);
    mocks.forEachTenant.mockImplementation(async (_job, operation) => ({
      failed: [],
      succeeded: [{ result: await operation('tenant-a'), tenantId: 'tenant-a' }],
    }));

    await reapOperationsForAllTenants({ json: vi.fn() } as never);

    const [, options] = mocks.sweep.mock.calls[0] as [unknown, { deliveryProbe?: unknown }];
    expect(options.deliveryProbe).toBe(probe);
    mocks.hatchetDelivery = false;
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
