import type { AgentOperationStatus } from '@lobechat/types';
import { and, asc, gte, inArray } from 'drizzle-orm';
import type { Context } from 'hono';

import { getServerDB } from '@/database/core/db-adaptor';
import { agentOperations } from '@/database/schemas';
import { surveyTenants } from '@/server/modules/Tenant/fanOut';
import { DEFAULT_STALE_AFTER_MS } from '@/server/services/agentRuntime/StaleOperationReaper';

/**
 * Statuses whose steps run inside a server process, so a rollout would cut them
 * off. Parked runs (`waiting_for_*`) resume through their own paths and are not
 * held by a process, unlike `isAgentOperationInFlight`, which counts them.
 */
const EXECUTING_STATUSES: AgentOperationStatus[] = ['idle', 'running'];

/**
 * Operations of the current tenant that are still alive: `idle`/`running`
 * with a lease refreshed within the stale-operation reaper's window. A step
 * holding its lock refreshes `updatedAt` every 90 s, so a live run is never
 * outside the window, and a run outside it is the reaper's to recover — the
 * same cut-off on both sides.
 */
const listInFlightOperations = async (since: Date) => {
  const db = await getServerDB();
  return db
    .select({
      createdAt: agentOperations.createdAt,
      id: agentOperations.id,
      parentOperationId: agentOperations.parentOperationId,
      status: agentOperations.status,
      stepCount: agentOperations.stepCount,
      trigger: agentOperations.trigger,
      updatedAt: agentOperations.updatedAt,
    })
    .from(agentOperations)
    .where(
      and(
        inArray(agentOperations.status, EXECUTING_STATUSES),
        gte(agentOperations.updatedAt, since),
      ),
    )
    .orderBy(asc(agentOperations.createdAt));
};

/**
 * Read-only release gate probe: lists agent operations still in flight in
 * every available tenant, each read through that tenant's own runtime role.
 * Frozen, offline or otherwise unadmitted tenants cannot run steps and are
 * only listed as skipped. Any tenant whose read failed answers 503, so a
 * caller deciding whether a rollout would interrupt work fails closed.
 *
 * Returns run metadata only: no credentials and no user content.
 */
export const listAgentInFlight = async (c: Context): Promise<Response> => {
  const since = new Date(Date.now() - DEFAULT_STALE_AFTER_MS);
  const { directory, failed, skipped, succeeded } = await surveyTenants(
    'cron:agent-in-flight',
    () => listInFlightOperations(since),
  );

  const operations = succeeded.flatMap(({ result, tenantId }) =>
    result.map((operation) => ({
      createdAt: operation.createdAt.toISOString(),
      id: operation.id,
      parentOperationId: operation.parentOperationId ?? null,
      status: operation.status,
      stepCount: operation.stepCount ?? 0,
      tenantId,
      trigger: operation.trigger ?? null,
      updatedAt: operation.updatedAt.toISOString(),
    })),
  );
  if (failed.length > 0) console.error('[cron:agent-in-flight] tenant reads failed: %o', failed);

  return c.json(
    {
      failedTenants: failed,
      operations,
      tenants: { checked: succeeded.length, directory, skipped },
      windowSeconds: DEFAULT_STALE_AFTER_MS / 1000,
    },
    failed.length > 0 ? 503 : 200,
  );
};
