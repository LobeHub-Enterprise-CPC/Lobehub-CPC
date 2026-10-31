import { Priority } from '@hatchet-dev/typescript-sdk/v1';
import debug from 'debug';

import { HATCHET_TIMING } from '@/server/modules/Hatchet/config';
import { classifyQueueMessage, STEP_METADATA_KEYS } from '@/server/modules/Hatchet/purpose';
import {
  assertRetryPolicy,
  deliveryDedupKey,
  getAgentStepTask,
  triggerDelivery,
} from '@/server/modules/Hatchet/tasks';
import type { DeliveryInput } from '@/server/modules/Hatchet/types';

import { type HealthCheckResult, type QueueMessage, type QueueStats } from '../types';
import { fitBodyToQuota } from './qstash';
import { type QueueServiceImpl } from './type';

const log = debug('lobe-server:service:queue:hatchet');

const PRIORITY = {
  high: Priority.HIGH,
  low: Priority.LOW,
  normal: Priority.MEDIUM,
} as const satisfies Record<NonNullable<QueueMessage['priority']>, Priority>;

/**
 * Queue-mode agent runtime messages as `cpc-agent-step` runs. A Hatchet worker
 * delivers each one to the same endpoint with the body, headers and signature
 * QStash would have sent, so the receiving route is unchanged. Unlike the
 * QStash client, delays keep millisecond precision.
 */
export class HatchetQueueServiceImpl implements QueueServiceImpl {
  async scheduleMessage(message: QueueMessage): Promise<string> {
    const {
      operationId,
      stepIndex,
      context,
      deduplicationId,
      endpoint,
      payload,
      delay = 50,
      priority = 'normal',
      retryDelay,
      retries = 3,
    } = message;
    assertRetryPolicy(retries, retryDelay);

    const tenantKey = message.execution?.tenantId ?? '_';
    const { body } = fitBodyToQuota(
      {
        body: {
          execution: message.execution,
          context,
          operationId,
          payload,
          priority,
          stepIndex,
          timestamp: Date.now(),
        },
      },
      operationId,
    );
    const input: DeliveryInput = {
      body: JSON.stringify(body),
      dedupKey: deliveryDedupKey(tenantKey, deduplicationId),
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Operation-Id': operationId,
        'X-Agent-Priority': priority,
        'X-Agent-Step-Index': stepIndex.toString(),
      },
      retries,
      ...(retryDelay === undefined ? {} : { retryDelay }),
      tenantKey,
      timeoutMs: HATCHET_TIMING.stepHttpTimeoutMs,
      url: endpoint,
    };

    const messageId = await triggerDelivery(getAgentStepTask(), input, {
      additionalMetadata: {
        [STEP_METADATA_KEYS.kind]: message.kind ?? 'operation',
        [STEP_METADATA_KEYS.operationId]: operationId,
        [STEP_METADATA_KEYS.purpose]: classifyQueueMessage(message),
        [STEP_METADATA_KEYS.stepIndex]: String(stepIndex),
        [STEP_METADATA_KEYS.tenantId]: tenantKey,
      },
      delayMs: delay,
      priority: PRIORITY[priority],
    });
    log(
      '[%s] Scheduled step %d to %s in %dms (%s)',
      operationId,
      stepIndex,
      endpoint,
      delay,
      messageId,
    );
    return messageId;
  }

  async scheduleBatchMessages(messages: QueueMessage[]): Promise<string[]> {
    return Promise.all(messages.map((message) => this.scheduleMessage(message)));
  }

  async cancelScheduledTask(messageId: string): Promise<void> {
    // As with QStash: nothing is cancelled here, the receiver re-checks the operation.
    log('Requested cancellation for message %s', messageId);
  }

  async getQueueStats(): Promise<QueueStats> {
    return {
      completedCount: 0,
      failedCount: 0,
      pendingCount: 0,
      processingCount: 0,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return {
      healthy: true,
      message: 'Hatchet queue service is ready',
    };
  }
}
