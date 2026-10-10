import { currentTenantScope } from '@lobechat/database/tenant';
import debug from 'debug';

import { tenantGateErrorOf } from '@/server/modules/Tenant/errors';
import { runInTenant } from '@/server/modules/Tenant/gate';

import { type HealthCheckResult, type QueueMessage, type QueueStats } from '../types';
import { type QueueServiceImpl } from './type';

const log = debug('queue:local');

/** How long a step of an unavailable (frozen, expired, unreachable) tenant waits before it is tried again. */
export const TENANT_DEFERRED_STEP_RETRY_MS = 30_000;

/** Tenant states in which a queued step is discarded rather than deferred (FR-AS-01). */
const DISCARDING_TENANT_CODES = new Set(['TENANT_NOT_FOUND', 'TENANT_OFFLINE']);

/**
 * Callback type for local execution
 * This is set by AgentRuntimeService to avoid circular dependency
 */
export type LocalExecutionCallback = (
  operationId: string,
  stepIndex: number,
  context: any,
  payload?: any,
) => Promise<void>;

/**
 * Local queue service implementation
 *
 * Instead of scheduling HTTP requests (like QStashQueueServiceImpl),
 * this implementation uses setTimeout to schedule execution callbacks,
 * allowing the event loop to continue between steps.
 *
 * Use case: Local development without QStash
 */
export class LocalQueueServiceImpl implements QueueServiceImpl {
  private executionCallback: LocalExecutionCallback | null = null;
  private deduplicatedExecutions: Map<string, string> = new Map();
  private pendingExecutions: Set<string> = new Set();

  /**
   * Set the execution callback (called by AgentRuntimeService)
   * This breaks the circular dependency by using callback injection
   */
  setExecutionCallback(callback: LocalExecutionCallback): void {
    this.executionCallback = callback;
  }

  async scheduleMessage(message: QueueMessage): Promise<string> {
    const { operationId, stepIndex, context, payload, delay = 50, deduplicationId } = message;

    if (deduplicationId) {
      const existingTaskId = this.deduplicatedExecutions.get(deduplicationId);
      if (existingTaskId) return existingTaskId;
    }

    const taskId = `local-${operationId}-${stepIndex}-${Date.now()}`;
    if (deduplicationId) this.deduplicatedExecutions.set(deduplicationId, taskId);

    log(
      'Local execution scheduled for step %d of operation %s (delay: %dms)',
      stepIndex,
      operationId,
      delay,
    );

    // Only the tenant id is kept: the scope captured here may be stale by the
    // time the step runs (credentials rotated while the tenant was frozen).
    const tenantId = currentTenantScope()?.tenantId;

    const execute = async () => {
      if (!this.executionCallback) {
        log('Warning: No execution callback set for local queue service');
        return;
      }

      this.pendingExecutions.add(taskId);

      try {
        log('Starting local execution for step %d of operation %s', stepIndex, operationId);
        await this.executionCallback(operationId, stepIndex, context, payload);
        log('Completed local execution for step %d of operation %s', stepIndex, operationId);
      } catch (error) {
        log(
          'Local execution failed for step %d of operation %s: %O',
          stepIndex,
          operationId,
          error,
        );
      } finally {
        this.pendingExecutions.delete(taskId);
      }
    };

    // Claim the step only while its tenant is admitted (FR-CP-06 stage 3,
    // FR-AS-01), in a scope admitted and opened now: a frozen tenant's step is
    // not started and is tried again later; an offline tenant's step is
    // discarded. Nothing has run yet, so a deferred step replays no side effect.
    // `execute` handles its own failures, so a rejection here is the admission.
    const run = async () => {
      if (!tenantId) return execute();
      try {
        await runInTenant(tenantId, execute);
      } catch (error) {
        const code = tenantGateErrorOf(error)?.code ?? 'TENANT_UNAVAILABLE';
        if (DISCARDING_TENANT_CODES.has(code)) {
          log('Dropping step %d of operation %s: %s', stepIndex, operationId, code);
          return;
        }
        log('Deferring step %d of operation %s: %s', stepIndex, operationId, code);
        setTimeout(run, TENANT_DEFERRED_STEP_RETRY_MS);
      }
    };

    // Use setTimeout to allow the current call stack to complete
    // This is important for createOperation to return before execution starts
    setTimeout(run, delay);

    return taskId;
  }

  async scheduleBatchMessages(messages: QueueMessage[]): Promise<string[]> {
    const taskIds: string[] = [];

    for (const message of messages) {
      const taskId = await this.scheduleMessage(message);
      taskIds.push(taskId);
    }

    log('Scheduled %d batch messages locally', messages.length);
    return taskIds;
  }

  async cancelScheduledTask(taskId: string): Promise<void> {
    // Local execution doesn't support cancellation of scheduled tasks
    // since they execute via setTimeout
    log('Cancel requested for task %s (not supported in local mode)', taskId);
  }

  async getQueueStats(): Promise<QueueStats> {
    return {
      completedCount: 0,
      failedCount: 0,
      pendingCount: this.pendingExecutions.size,
      processingCount: 0,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      healthy: true,
      message: `Local queue service healthy, ${this.pendingExecutions.size} pending executions`,
    };
  }
}
