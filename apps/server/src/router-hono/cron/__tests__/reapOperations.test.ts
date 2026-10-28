// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentServices: [] as { args: unknown[]; executeStep: ReturnType<typeof vi.fn> }[],
  forEachTenant: vi.fn(),
  getOperationMetadata: vi.fn(),
  sweep: vi.fn(),
}));

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: async () => 'tenant-db' }));
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

const sweepResult = { abandoned: 0, examined: 1, failed: 0, redriven: 1, skipped: 0 };

describe('stale-operation cron sweep', () => {
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
    expect(response.body).toMatchObject({ examined: 1, redriven: 1 });
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
