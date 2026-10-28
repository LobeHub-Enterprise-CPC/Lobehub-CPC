import { type AgentRuntimeContext } from '@lobechat/agent-runtime';

export interface QueueMessage {
  context?: AgentRuntimeContext;
  /** Stable provider-side execute-once key for crash-safe enqueue retries. */
  deduplicationId?: string;
  delay?: number;
  endpoint: string;
  execution?: { tenantId: string; sourceAcceptedVersion: number };
  /**
   * `operation` (default): a step of an agent operation; its execution version is the one stored
   * on the `agent_operations` row. `tenant-job`: tenant-scoped work that has no operation row
   * (e.g. a deferred bot replay); it runs under the version of the tenant that scheduled it.
   */
  kind?: 'operation' | 'tenant-job';
  operationId: string;
  payload?: any;
  priority?: 'high' | 'normal' | 'low';
  retries?: number;
  retryDelay?: string;
  stepIndex: number;
}

export interface QueueStats {
  completedCount: number;
  failedCount: number;
  pendingCount: number;
  processingCount: number;
}

export interface HealthCheckResult {
  healthy: boolean;
  message?: string;
}
