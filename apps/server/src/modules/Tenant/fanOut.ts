import debug from 'debug';

import { runInTenant } from './gate';
import { getTenantRuntime } from './runtime';

const log = debug('lobe-server:tenant-fan-out');

export interface TenantFanOutResult<T> {
  failed: { reason: string; tenantId: string }[];
  succeeded: { result: T; tenantId: string }[];
}

/**
 * Runs deployment-wide background work once per available tenant (spec
 * FR-AS-02): startup jobs and crons have no request, so each tenant gets its
 * own admitted scope and its own tenant database. Tenants run one after
 * another; one tenant failing is recorded and does not stop the others.
 */
export const forEachTenant = async <T>(
  job: string,
  operation: (tenantId: string) => Promise<T>,
): Promise<TenantFanOutResult<T>> => {
  const result: TenantFanOutResult<T> = { failed: [], succeeded: [] };
  const tenantIds = await getTenantRuntime().listAvailableTenantIds();
  for (const tenantId of tenantIds) {
    try {
      const value = await runInTenant(tenantId, () => operation(tenantId));
      result.succeeded.push({ result: value, tenantId });
    } catch (error) {
      const reason =
        (error as { code?: string })?.code ?? (error as Error)?.name ?? 'UNKNOWN_ERROR';
      log('%s failed for tenant %s: %O', job, tenantId, error);
      result.failed.push({ reason, tenantId });
    }
  }
  log('%s: %d tenant(s) ok, %d failed', job, result.succeeded.length, result.failed.length);
  return result;
};
