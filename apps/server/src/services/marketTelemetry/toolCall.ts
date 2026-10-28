import { createHash, randomUUID } from 'node:crypto';

import { CURRENT_VERSION } from '@lobechat/const';

import {
  buildToolCallReport,
  type CompletedTelemetryExecution,
  inspectToolResultOutcome,
  startTelemetryExecution,
  type StartTelemetryExecutionDeps,
  type TelemetryOutcome,
  type ToolCallDescriptor,
} from '@/libs/market-telemetry';

import { type DeliverTelemetryDeps, scheduleMarketTelemetry } from './deliver';
import { type TelemetryReportContext } from './reporter';

/** Leaves room in the 255-character event id for `v1:call:` and the attempt. */
const EXECUTION_ID_MAX_LENGTH = 150;

/**
 * An execution id the event id can carry. Short ids stay readable; an
 * oversized one (a provider's tool call id plus an operation id) becomes a
 * digest of itself, which is still deterministic, so a redelivered step maps to
 * the same event.
 */
export const compactExecutionId = (executionId: string): string =>
  executionId.length <= EXECUTION_ID_MAX_LENGTH
    ? executionId
    : `h-${createHash('sha256').update(executionId).digest('hex')}`;

const byteSize = (value: unknown): number | undefined => {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return undefined;
  }
};

export interface ToolCallTelemetryInput {
  /** The scheduler's attempt number (the runtime's tool retry loop); 1 when it has none. */
  attempt?: number;
  /** The stdio command, for the report's metadata. */
  command?: string;
  /** Who is asking, and what the opt-out and authentication decisions need. */
  context: TelemetryReportContext;
  /**
   * Stable identity of this execution (operation + tool call, or a client
   * invocation id). Absent means the caller cannot name it, so it is an
   * independent execution with an id of its own.
   */
  executionId?: string;
  identifier: string;
  mcpType?: string;
  meta?: Pick<ToolCallDescriptor, 'customPluginInfo' | 'isCustomPlugin' | 'sessionId' | 'version'>;
  methodName: string;
  /** Only its size leaves. */
  requestPayload?: unknown;
  /** The call was tunnelled to the user's device. */
  viaDevice?: boolean;
}

export interface ToolCallTelemetryCompletion extends TelemetryOutcome {
  /** Only its size leaves; failure it reports about itself is read from it. */
  result?: unknown;
  /** Known only once the call is routed: it was tunnelled to the user's device. */
  viaDevice?: boolean;
}

export interface ToolCallTelemetry {
  /** Fixes the outcome and schedules the report. Only the first call counts. */
  complete: (completion?: ToolCallTelemetryCompletion) => CompletedTelemetryExecution;
  readonly eventId: string;
}

export interface ToolCallTelemetryDeps extends StartTelemetryExecutionDeps, DeliverTelemetryDeps {}

/**
 * The execution-completion boundary of an MCP tool call, shared by every path
 * that runs one: the background agent runtime (cloud, http/sse, stdio, device),
 * and the tRPC procedures the web and desktop clients call. Those procedures
 * only translate their context into this input; none of them builds an event.
 *
 * Call it where the execution starts and `complete` where its outcome is
 * known. The event identity comes from the execution's own id and attempt, and
 * success, duration and time are fixed by `complete`, so the report that goes
 * out — and every retry of it — says the same thing.
 */
export const beginToolCallTelemetry = (
  input: ToolCallTelemetryInput,
  { report, schedule, ...executionDeps }: ToolCallTelemetryDeps = {},
): ToolCallTelemetry => {
  const execution = startTelemetryExecution(
    {
      attempt: input.attempt ?? 1,
      eventType: 'call',
      executionId: compactExecutionId(input.executionId ?? randomUUID()),
    },
    executionDeps,
  );
  const requestSizeBytes =
    input.requestPayload === undefined ? undefined : byteSize(input.requestPayload);
  let scheduled = false;

  return {
    complete: (completion = {}) => {
      const { result, viaDevice, ...explicit } = completion;
      const fromResult = inspectToolResultOutcome(result);
      const completed = execution.complete({
        ...explicit,
        isError: explicit.isError ?? fromResult.isError,
        success:
          explicit.success === false || fromResult.success === false ? false : explicit.success,
      });

      if (!scheduled) {
        scheduled = true;
        const toolCallReport = buildToolCallReport(completed, {
          appVersion: CURRENT_VERSION,
          command: input.command,
          identifier: input.identifier,
          mcpType: input.mcpType,
          methodName: input.methodName,
          requestSizeBytes,
          responseSizeBytes: completed.success && result !== undefined ? byteSize(result) : 0,
          viaDevice: viaDevice ?? input.viaDevice,
          ...input.meta,
        });

        scheduleMarketTelemetry(toolCallReport, input.context, { report, schedule });
      }

      return completed;
    },
    eventId: execution.eventId,
  };
};
