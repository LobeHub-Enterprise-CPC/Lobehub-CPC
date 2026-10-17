import {
  beginToolCallTelemetry,
  type ToolCallTelemetry,
  type ToolCallTelemetryInput,
} from '@/server/services/marketTelemetry';

export interface ToolCallReportMeta {
  customPluginInfo?: {
    avatar?: string;
    description?: string;
    name?: string;
  };
  /**
   * The client's id for this invocation, kept across transport retries of the
   * same call. Without it the call cannot be told apart from a repeat of it, so
   * the server treats the request as an independent execution.
   */
  executionId?: string;
  isCustomPlugin?: boolean;
  sessionId?: string;
  version?: string;
}

/** The slice of the tRPC context a report needs. */
export interface ToolCallReportContext {
  /** Only used by a deployment without tenants; see `reportMarketTelemetry`. */
  marketAccessToken?: string;
  serverDB?: ToolCallTelemetryInput['context']['serverDB'];
  /** What the `telemetry` middleware decided for this user. */
  telemetryEnabled?: boolean;
  userId?: string | null;
}

export interface BeginToolCallReportParams {
  context: ToolCallReportContext;
  /** Plugin/tool identifier */
  identifier: string;
  /** MCP connection type */
  mcpType: string;
  meta?: ToolCallReportMeta;
  /** Request payload; only its size is reported. */
  requestPayload: unknown;
  /** Tool/method name */
  toolName: string;
}

/**
 * Foreground tool-call reporting for the tRPC procedures the web and desktop
 * clients call. It only translates the request into the shared execution
 * boundary (`beginToolCallTelemetry`), which owns the event identity, the
 * outcome, whether and how to report, and scheduling after the response. Call it
 * where the call starts and `complete` where its outcome is known.
 */
export const beginToolCallReport = ({
  context,
  identifier,
  mcpType,
  meta,
  requestPayload,
  toolName,
}: BeginToolCallReportParams): ToolCallTelemetry => {
  const { executionId, ...descriptorMeta } = meta ?? {};

  return beginToolCallTelemetry({
    context: {
      marketAccessToken: context.marketAccessToken,
      serverDB: context.serverDB,
      telemetryEnabled: context.telemetryEnabled,
      userId: context.userId,
    },
    executionId,
    identifier,
    mcpType,
    meta: descriptorMeta,
    methodName: toolName,
    requestPayload,
  });
};
