import debug from 'debug';
import type { Context } from 'hono';

import { getServerDB } from '@/database/core/db-adaptor';
import { AgentRuntimeCoordinator } from '@/server/modules/AgentRuntime';
import { isHatchetDeliveryEnabled } from '@/server/modules/Hatchet/config';
import { createHatchetDeliveryProbe } from '@/server/modules/Hatchet/probe';
import { forEachTenant } from '@/server/modules/Tenant/fanOut';
import { StaleOperationReaper } from '@/server/services/agentRuntime';
import { AsyncToolResumeReconciler } from '@/server/services/agentRuntime/AsyncToolResumeReconciler';
import { SubAgentBridgeReconciler } from '@/server/services/agentRuntime/SubAgentBridgeReconciler';
import { AiAgentService } from '@/server/services/aiAgent';
import { QueueService } from '@/server/services/queue';
import { LocalQueueServiceImpl } from '@/server/services/queue/impls';

const log = debug('lobe-server:cron:reap-operations');

/**
 * The queue redriven steps are published to. In queue mode that is the provider,
 * which delivers them to the tenant's `/api/agent/run`. In local mode a step runs
 * only in-process through a runtime's own callback, which a bare queue lacks, so
 * this one steps the operation the way `/api/agent/run` does: through
 * `AiAgentService` for the operation's owner and workspace, whose runtime then
 * queues the following steps in this process.
 */
export const createRedriveQueue = (): QueueService => {
  const queueService = new QueueService();
  const impl = queueService.getImpl();
  if (impl instanceof LocalQueueServiceImpl) {
    impl.setExecutionCallback(async (operationId, stepIndex, context, payload) => {
      const metadata = await new AgentRuntimeCoordinator().getOperationMetadata(operationId);
      if (!metadata?.userId) {
        log('[%s][%d] no operation metadata, redrive dropped', operationId, stepIndex);
        return;
      }
      const service = new AiAgentService(await getServerDB(), metadata.userId, {
        includeShareVisitor: Boolean(metadata.streamOwnerUserId),
        workspaceId: metadata.workspaceId,
      });
      await service.executeStep({ context, operationId, stepIndex, ...payload });
    });
  }
  return queueService;
};

/** What the fan-out records for a tenant whose work threw. */
const failureReason = (error: unknown): string =>
  (error as { code?: string })?.code ?? (error as Error)?.name ?? 'UNKNOWN_ERROR';

/**
 * Deployment-wide stale-operation recovery (see {@link StaleOperationReaper}):
 * sweeps every available tenant in turn. A tenant whose sweep threw answers 5xx
 * so the scheduler records the failed run. A reconciler that threw is listed
 * with its `phase`, without dropping what the tenant's other sweeps did.
 *
 * `failed` counts recoveries that threw, except in `reconciliation`, where it
 * counts bindings settled as failed and `errors` the ones that threw.
 */
export const reapOperationsForAllTenants = async (c: Context): Promise<Response> => {
  const queueService = createRedriveQueue();
  const deliveryProbe = isHatchetDeliveryEnabled() ? createHatchetDeliveryProbe() : undefined;
  const { failed, succeeded } = await forEachTenant(
    'cron:agent-reap-operations',
    async (tenantId) => {
      const db = await getServerDB();
      const reaper = await new StaleOperationReaper(db, { deliveryProbe, queueService }).sweep();
      const phaseFailures: { phase: string; reason: string }[] = [];
      const isolated = async <T>(phase: string, sweep: () => Promise<T>) => {
        try {
          return await sweep();
        } catch (error) {
          log('%s sweep failed for tenant %s: %O', phase, tenantId, error);
          phaseFailures.push({ phase, reason: failureReason(error) });
        }
      };
      const asyncToolResume = deliveryProbe
        ? await isolated('asyncToolResume', () =>
            new AsyncToolResumeReconciler(db, { deliveryProbe, queueService }).sweep(),
          )
        : undefined;
      const reconciliation = await isolated('subAgentBridge', () =>
        new SubAgentBridgeReconciler(db).sweep(),
      );
      return { asyncToolResume, phaseFailures, reaper, reconciliation };
    },
  );

  const totals = { abandoned: 0, examined: 0, failed: 0, redriven: 0, skipped: 0 };
  const skippedReasons: Record<string, number> = {};
  const asyncToolResume = { confirmed: 0, examined: 0, exhausted: 0, failed: 0, republished: 0 };
  const reconciliation = { errors: 0, failed: 0, processed: 0, recovered: 0, skipped: 0 };
  const failedTenants: { phase?: string; reason: string; tenantId: string }[] = [...failed];
  for (const { result, tenantId } of succeeded) {
    const { reaper, asyncToolResume: resume, reconciliation: bridge } = result;
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += reaper[key];
    for (const [reason, count] of Object.entries(reaper.skippedReasons))
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + count;
    if (resume)
      for (const key of Object.keys(asyncToolResume) as (keyof typeof asyncToolResume)[])
        asyncToolResume[key] += resume[key];
    if (bridge)
      for (const key of Object.keys(reconciliation) as (keyof typeof reconciliation)[])
        reconciliation[key] += bridge[key];
    for (const failure of result.phaseFailures) failedTenants.push({ ...failure, tenantId });
    if (reaper.redriven > 0 || reaper.abandoned > 0 || reaper.failed > 0)
      console.info('[cron:reap-operations] tenant %s: %o', tenantId, reaper);
  }
  if (failedTenants.length > 0)
    console.error('[cron:reap-operations] tenant sweeps failed: %o', failedTenants);

  return c.json(
    { ...totals, asyncToolResume, failedTenants, reconciliation, skippedReasons },
    failedTenants.length > 0 ? 500 : 200,
  );
};
