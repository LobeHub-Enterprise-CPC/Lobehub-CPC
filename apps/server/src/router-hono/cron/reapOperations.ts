import debug from 'debug';
import type { Context } from 'hono';

import { getServerDB } from '@/database/core/db-adaptor';
import { AgentRuntimeCoordinator } from '@/server/modules/AgentRuntime';
import { forEachTenant } from '@/server/modules/Tenant/fanOut';
import { StaleOperationReaper } from '@/server/services/agentRuntime';
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

/**
 * Deployment-wide stale-operation recovery (see {@link StaleOperationReaper}):
 * sweeps every available tenant in turn. A tenant whose sweep threw answers 5xx
 * so the scheduler records the failed run.
 */
export const reapOperationsForAllTenants = async (c: Context): Promise<Response> => {
  const queueService = createRedriveQueue();
  const { failed, succeeded } = await forEachTenant('cron:agent-reap-operations', async () =>
    new StaleOperationReaper(await getServerDB(), { queueService }).sweep(),
  );

  const totals = { abandoned: 0, examined: 0, failed: 0, redriven: 0, skipped: 0 };
  for (const { result, tenantId } of succeeded) {
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += result[key];
    if (result.redriven > 0 || result.abandoned > 0 || result.failed > 0)
      console.info('[cron:reap-operations] tenant %s: %o', tenantId, result);
  }
  if (failed.length > 0) console.error('[cron:reap-operations] tenant sweeps failed: %o', failed);

  return c.json({ ...totals, failedTenants: failed }, failed.length > 0 ? 500 : 200);
};
