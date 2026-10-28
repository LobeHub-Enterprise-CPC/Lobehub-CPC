import { currentTenantScope, trackTenantWork } from '@lobechat/database/tenant';
import debug from 'debug';

import type { AgentSignalWorkflowRunPayload } from '../types';

const log = debug('lobe-server:workflows:agent-signal');
const localRunQueues = new Map<string, Promise<void>>();

const deferLocalRun = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * Schedules one non-durable Agent Signal workflow inside the current server process.
 *
 * Local Agent Runtime deliberately avoids QStash. Deferring execution lets the ingress request
 * return before the pipeline starts, matching the foreground/background boundary of Upstash
 * Workflow without pretending to provide its durability guarantees. Runs sharing a scope are
 * chained to preserve the queue runtime's `parallelism: 1` behavior; otherwise a later local event
 * can hit the first run's scope lock and be dropped instead of waiting.
 */
export const scheduleLocalAgentSignalRun = (
  payload: AgentSignalWorkflowRunPayload,
  headers: Headers,
): { workflowRunId: string } => {
  const workflowRunId = `local-${payload.sourceEvent.sourceId}`;
  const logContext = {
    agentId: payload.agentId,
    sourceId: payload.sourceEvent.sourceId,
    userId: payload.userId,
    workflowRunId,
  };

  log('Scheduling local workflow payload=%O', logContext);

  const queueKey = JSON.stringify([
    currentTenantScope()?.tenantId ?? null,
    payload.sourceEvent.scopeKey,
  ]);
  const previousRun = localRunQueues.get(queueKey) ?? Promise.resolve();
  const currentRun = previousRun
    .catch(() => undefined)
    .then(deferLocalRun)
    .then(async () => {
      try {
        const [
          { executeAgentSignalSourceEvent },
          { inMemorySourceEventStore },
          { inMemoryRuntimeGuardBackend },
          { runAgentSignalWorkflow },
        ] = await Promise.all([
          import('@/server/services/agentSignal/orchestrator'),
          import('@/server/services/agentSignal/store/adapters/memory/sourceEventStore'),
          import('@/server/services/agentSignal/runtime/backend/memoryGuard'),
          import('../run'),
        ]);

        await runAgentSignalWorkflow(
          {
            headers,
            requestPayload: payload,
            run: async (_stepId, handler) => handler(),
          },
          {
            createRuntimeGuardBackend: () => inMemoryRuntimeGuardBackend,
            executeSourceEvent: (input, context, options) =>
              executeAgentSignalSourceEvent(input, context, {
                ...options,
                store: inMemorySourceEventStore,
              }),
          },
        );
      } catch (error) {
        console.error('[AgentSignal] Local workflow execution failed:', {
          ...logContext,
          error,
        });
      }
    });

  localRunQueues.set(queueKey, currentRun);

  void trackTenantWork(() => currentRun).finally(() => {
    if (localRunQueues.get(queueKey) === currentRun) {
      localRunQueues.delete(queueKey);
    }
  });

  return { workflowRunId };
};
