import { TenantGateError, tenantGateErrorOf } from '@/server/modules/Tenant/errors';
import type { TenantLiveResources } from '@/server/modules/Tenant/liveResources';
import type { TenantRuntime } from '@/server/modules/Tenant/runtime';
import type { LifecycleHooks } from '@/server/services/tenantControlPlane/service';

export interface LifecycleHookDeps {
  invalidateAuth: (tenantId: string) => void;
  live: Pick<TenantLiveResources, 'resume' | 'suspend'>;
  runtime: Pick<TenantRuntime, 'assertAdmitted' | 'drainTransactions' | 'invalidate'>;
  waitForClaims: (tenantId: string) => Promise<void>;
}

/** Stop local work, collect every process's durable receipt, then drain tenant transactions. */
export const createLifecycleHooks = ({
  invalidateAuth,
  live,
  runtime,
  waitForClaims,
}: LifecycleHookDeps): LifecycleHooks => {
  /**
   * Closes the tenant's live resources in this process (streams, bot
   * connections, running agent steps). A resource that fails to close makes
   * the stage fail; the retried event closes what is left. Nothing is closed
   * when a newer event admitted the tenant again.
   */
  const suspendLocal = async (tenantId: string) => {
    let reason: TenantGateError | undefined;
    try {
      await runtime.assertAdmitted(tenantId, 0);
    } catch (error) {
      reason =
        tenantGateErrorOf(error) ??
        new TenantGateError('TENANT_UNAVAILABLE', undefined, { cause: error });
    }
    if (reason) await live.suspend(tenantId, reason);
  };

  return {
    closeRealtime: async (tenantId) => {
      await suspendLocal(tenantId);
    },
    drainTransactions: async (tenantId) => {
      await waitForClaims(tenantId);
      await runtime.drainTransactions(tenantId);
    },
    invalidateCaches: async (tenantId) => {
      runtime.invalidate(tenantId);
      invalidateAuth(tenantId);
    },
    resumeQueue: (tenantId) => live.resume(tenantId),
    // Steps not yet started are no longer claimed (the local queue and the
    // request gate re-check admission); running steps were cancelled with the
    // other live resources. Repeat the local close for anything bound since.
    stopQueue: async (tenantId) => {
      await suspendLocal(tenantId);
    },
  };
};
