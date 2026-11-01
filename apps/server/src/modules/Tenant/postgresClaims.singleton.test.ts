// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ drain: vi.fn(async () => {}), remove: vi.fn(async () => {}) }));
vi.mock('@/server/modules/AgentRuntime/stepDrain', () => ({ drainAgentSteps: mocks.drain }));
vi.mock('./claims', () => ({ TenantClaims: class {} }));
vi.mock('./runtime', () => ({ getTenantRuntime: vi.fn() }));
vi.mock('@lobechat/database/platform', () => ({
  getPlatformDB: () => ({
    delete: () => ({ where: mocks.remove }),
    transaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        delete: () => ({ where: async () => {} }),
        insert: () => ({ values: () => ({ onConflictDoUpdate: async () => {} }) }),
        select: () => ({ from: async () => [] }),
      }),
  }),
  TENANT_DESTROYED_GENERATION: -1,
  tenantDestruction: {},
  tenantLeaseBlocker: vi.fn(),
  tenantLifecycle: {},
  tenantRuntimeExternalWork: {},
  tenantRuntimeProcess: { processId: {}, leaseExpiresAt: {} },
}));

describe('process-wide tenant lease', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, Symbol.for('lobehub.tenantProcessLease'));
    Reflect.deleteProperty(globalThis, Symbol.for('lobehub.tenantClaims'));
  });

  it('shares the lease across module instances and drains and re-signals only once', async () => {
    const terminate = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.resetModules();
    const first = await import('./postgresClaims');
    vi.resetModules();
    const second = await import('./postgresClaims');
    await Promise.all([first.tenantProcessLease.ensure(), second.tenantProcessLease.ensure()]);
    expect(first.tenantProcessLease).toBe(second.tenantProcessLease);
    expect(first.tenantClaims).toBe(second.tenantClaims);
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledTimes(1));
    expect(mocks.drain).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    await first.tenantProcessLease.stop();
    if (first.tenantProcessLease !== second.tenantProcessLease)
      await second.tenantProcessLease.stop();
  });
});
