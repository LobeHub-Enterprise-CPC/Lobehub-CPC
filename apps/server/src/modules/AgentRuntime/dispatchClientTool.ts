import type { ChatToolPayload } from '@lobechat/types';
import debug from 'debug';

import { createGatewayAttempt } from '@/server/services/gatewayAuthorization/attempts';
import { operationGatewaySource } from '@/server/services/gatewayAuthorization/context';
import {
  loadGatewayOperation,
  operationExecutionContext,
} from '@/server/services/gatewayAuthorization/operationAuthority';
import { waitForGatewayResult } from '@/server/services/gatewayAuthorization/waiter';
import type { ToolExecutionResultResponse } from '@/server/services/toolExecution/types';

import { GLOBAL_DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS } from './resolveToolTimeout';
import type { ToolResultPayload } from './ToolResultWaiter';
import type { IStreamEventManager } from './types';

const log = debug('lobe-server:agent-runtime:dispatch-client-tool');

interface DispatchContext {
  agentId?: string | null;
  /** Assistant message that carries this tool call. */
  assistantMessageId?: string;
  documentId?: string | null;
  groupId?: string | null;
  operationId: string;
  rootOperationId?: string;
  scope?: string | null;
  signal?: AbortSignal;
  sourceMessageId?: string | null;
  streamManager: IStreamEventManager;
  taskId?: string | null;
  threadId?: string | null;
  /**
   * Per-call execution budget in milliseconds, normally produced by
   * `resolveToolTimeoutMs`. When omitted, falls back to the global default
   * (`GLOBAL_DEFAULT_TIMEOUT_MS`). Always clamped to
   * `[MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]` regardless of source — the client is
   * a suggester, this dispatcher is the arbiter.
   */
  timeoutMs?: number;
  topicId?: string | null;
}

const clampTimeout = (value: number): number =>
  Math.min(Math.max(Math.trunc(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);

const buildTimeoutResult = (executionTime: number): ToolExecutionResultResponse => ({
  content: '',
  error: { message: 'Tool execution timed out', type: 'timeout' },
  executionTime,
  success: false,
});

const buildErrorResult = (
  executionTime: number,
  error: unknown,
  type = 'dispatch_failed',
): ToolExecutionResultResponse => ({
  content: '',
  error: {
    message: error instanceof Error ? error.message : String(error),
    type,
  },
  executionTime,
  success: false,
});

/**
 * Dispatch a tool execution to the client via Agent Gateway WebSocket and
 * block-await the result on Redis. Never throws: any error path produces a
 * failed ClientToolExecutionResult so the agent loop can continue.
 *
 * The caller is expected to gate on `typeof streamManager.sendToolExecute ===
 * 'function'` and `chatToolPayload.executor === 'client'` before invoking.
 */
export async function dispatchClientTool(
  chatToolPayload: ChatToolPayload,
  ctx: DispatchContext,
): Promise<ToolExecutionResultResponse> {
  const { operationId, streamManager } = ctx;
  const startedAt = Date.now();

  if (typeof streamManager.sendToolExecute !== 'function') {
    return buildErrorResult(
      0,
      'Gateway notifier does not support tool_execute',
      'gateway_unsupported',
    );
  }

  const timeoutMs = clampTimeout(ctx.timeoutMs ?? GLOBAL_DEFAULT_TIMEOUT_MS);

  try {
    log(
      '[%s] dispatching client tool %s/%s (toolCallId=%s, timeout=%dms)',
      operationId,
      chatToolPayload.identifier,
      chatToolPayload.apiName,
      chatToolPayload.id,
      timeoutMs,
    );

    const execution = await operationExecutionContext(operationId);
    const row = await loadGatewayOperation(operationId);
    const intent = await createGatewayAttempt({
      ...execution,
      source: operationGatewaySource(row.userId, operationId),
      targetPrincipal: { kind: 'user', id: row.userId },
      action: 'operations.tool-execute',
      operationId,
      toolCallId: chatToolPayload.id,
      resourceId: operationId,
      attemptExpiresAt: startedAt + timeoutMs,
    });
    await streamManager.sendToolExecute(operationId, {
      intent,
      agentId: ctx.agentId,
      apiName: chatToolPayload.apiName,
      arguments: chatToolPayload.arguments,
      assistantMessageId: ctx.assistantMessageId,
      documentId: ctx.documentId,
      executionTimeoutMs: timeoutMs,
      groupId: ctx.groupId,
      identifier: chatToolPayload.identifier,
      rootOperationId: ctx.rootOperationId ?? operationId,
      scope: ctx.scope,
      sourceMessageId: ctx.sourceMessageId,
      taskId: ctx.taskId,
      threadId: ctx.threadId,
      toolCallId: chatToolPayload.id,
      topicId: ctx.topicId,
    });

    const callback = await waitForGatewayResult(
      { operationId, toolCallId: chatToolPayload.id, attemptId: intent.attemptId },
      {
        execution,
        expiresAt: intent.attemptExpiresAt,
        signal: ctx.signal ?? new AbortController().signal,
      },
    );
    if (callback.outcome !== 'completed')
      return buildErrorResult(Date.now() - startedAt, callback.outcome, 'executionUnknown');
    const result = callback.result as ToolResultPayload;
    const executionTime = Date.now() - startedAt;

    if (!result) {
      log(
        '[%s] client tool %s timed out after %dms',
        operationId,
        chatToolPayload.id,
        executionTime,
      );
      return buildTimeoutResult(executionTime);
    }

    return projectToExecutionResult(result, executionTime);
  } catch (error) {
    const executionTime = Date.now() - startedAt;
    log('[%s] client tool dispatch failed: %O', operationId, error);
    return buildErrorResult(executionTime, error);
  }
}

function projectToExecutionResult(
  payload: ToolResultPayload,
  executionTime: number,
): ToolExecutionResultResponse {
  return {
    content: payload.content ?? '',
    // Absent when the device or the gateway is too old to report it; the
    // server-observed `executionTime` is always present.
    deviceExecutionTime: payload.executionTimeMs,
    error: payload.error,
    executionTime,
    state: payload.state,
    success: payload.success,
    // Forward the client-relayed Work registration intent so the agent runtime
    // loop calls `registerWork` (the persist path strips it — never hits the DB).
    workRegistration: payload.workRegistration,
  };
}
