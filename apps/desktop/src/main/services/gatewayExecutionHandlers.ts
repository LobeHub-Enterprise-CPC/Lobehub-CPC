import type {
  AgentRunRequestMessage,
  GatewayClient,
  GatewayMcpParams,
  MessageApiRequestMessage,
  RpcRequestMessage,
  SystemInfoRequestMessage,
  ToolCallRequestMessage,
  ToolCallResponseMessage,
} from '@lobechat/device-gateway-client';
import type { RuntimeProbeCache } from '@lobechat/heterogeneous-agents/runtimeProbeCache';

import type { App } from '@/core/App';
import { createLogger } from '@/utils/logger';

import { collectGatewaySystemInfo } from './gatewaySystemInfo';

const logger = createLogger('services:GatewayExecutionHandlers');

interface ExecutionRequest {
  attemptId?: string;
  executionSignal?: AbortSignal;
  isExecutionCurrent?: () => boolean;
}
const executionCurrent = (request: ExecutionRequest) =>
  !!request.attemptId &&
  !!request.executionSignal &&
  !request.executionSignal.aborted &&
  request.isExecutionCurrent?.() === true;

/**
 * Result envelope a tool-call handler must return. Mirrors
 * `BuiltinServerRuntimeOutput` so the renderer-side and remote-device paths
 * stay symmetric: `content` is the LLM-facing prompt text; `state` carries the
 * structured payload that downstream persists into `pluginState`.
 */
interface ToolCallResult {
  content: string;
  error?: unknown;
  state?: unknown;
  success: boolean;
}

interface MessageApiHandler {
  (
    platform: string,
    apiName: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

interface ToolCallHandler {
  (
    identifier: string | undefined,
    apiName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ToolCallResult>;
}

/**
 * Handler for tunneled stdio MCP calls. Unlike {@link ToolCallHandler} (which
 * keys on `apiName` for builtin local-system tools), this carries the MCP
 * server identity + connection params so the device can spawn the local stdio
 * server and invoke the tool on it.
 */
interface McpCallHandler {
  (
    mcpCall: {
      apiName: string;
      arguments: string;
      identifier: string;
      params: GatewayMcpParams;
    },
    signal?: AbortSignal,
  ): Promise<ToolCallResult>;
}

/**
 * Coerce a runtime error (which may be an Error, string, or `{ message }`
 * object) into the string shape the wire protocol expects. Returns undefined
 * when there's no error to transmit.
 */
const serializeWireError = (err: unknown): string | undefined => {
  if (err === undefined || err === null) return undefined;
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

interface AgentRunHandler {
  (request: AgentRunRequestMessage): Promise<{ reason?: string; status: 'accepted' | 'rejected' }>;
}

/**
 * Handler for generic server-internal device RPCs (e.g. workspace-init scans).
 * Dispatches by `method` name and returns the JSON-serializable result. Distinct
 * from {@link ToolCallHandler} — RPCs are never exposed to the agent.
 */
interface RpcHandler {
  (method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
}

export class GatewayExecutionHandlers {
  toolCallHandler: ToolCallHandler | null = null;
  mcpCallHandler: McpCallHandler | null = null;
  messageApiHandler: MessageApiHandler | null = null;
  agentRunHandler: AgentRunHandler | null = null;
  rpcHandler: RpcHandler | null = null;

  constructor(
    private app: App,
    private agentRuntimes: RuntimeProbeCache,
  ) {}
  // ─── System Info ───

  /**
   * Triggering workflow: gateway `system_info_request` -> handleSystemInfoRequest
   * -> {@link GatewayClient.sendSystemInfoResponse}, including desktop tool support.
   */
  async handleSystemInfoRequest(client: GatewayClient, request: SystemInfoRequestMessage) {
    if (!executionCurrent(request)) return;
    logger.info(`Received system_info_request: requestId=${request.requestId}`);
    try {
      if (!executionCurrent(request)) return;
      client.sendSystemInfoResponse({
        attemptId: request.attemptId,
        requestId: request.requestId,
        result: { success: true, systemInfo: await collectGatewaySystemInfo(this.agentRuntimes) },
      });
    } catch (error) {
      // The gateway keeps the agent run parked until a correlated reply arrives,
      // so a failed collection must still answer instead of only logging.
      logger.error(`system_info_request failed: requestId=${request.requestId}`, error);
      if (!executionCurrent(request)) return;
      client.sendSystemInfoResponse({
        attemptId: request.attemptId,
        requestId: request.requestId,
        result: { success: false },
      });
    }
  }

  // ─── Generic Device RPC ───

  async handleRpcRequest(client: GatewayClient, request: RpcRequestMessage) {
    if (!executionCurrent(request)) return;
    const { method, params, requestId } = request;
    logger.info(`Received rpc_request: method=${method}, requestId=${requestId}`);

    if (!this.rpcHandler) {
      if (!executionCurrent(request)) return;
      client.sendRpcResponse({
        attemptId: request.attemptId,
        requestId,
        result: { error: 'No RPC handler registered', success: false },
      });
      return;
    }

    try {
      const data = await this.rpcHandler(method, params, request.executionSignal);
      if (!executionCurrent(request)) return;
      client.sendRpcResponse({
        attemptId: request.attemptId,
        requestId,
        result: { data, success: true },
      });
    } catch (error) {
      logger.error(`rpc_request method=${method} failed:`, serializeWireError(error));
      if (!executionCurrent(request)) return;
      client.sendRpcResponse({
        attemptId: request.attemptId,
        requestId,
        result: { error: serializeWireError(error), success: false },
      });
    }
  }

  // ─── Agent Run ───

  handleAgentRunRequest = async (
    client: GatewayClient,
    request: AgentRunRequestMessage,
    connectionWorkspaceId?: string,
  ) => {
    if (!executionCurrent(request)) return;
    logger.info(
      `Received agent_run_request: operationId=${request.operationId} type=${request.agentType}`,
    );

    if (!this.agentRunHandler) {
      logger.warn('No agent run handler configured, rejecting request');
      if (!executionCurrent(request)) return;
      client.sendAgentRunAck({
        attemptId: request.attemptId,
        operationId: request.operationId,
        reason: 'no handler',
        status: 'rejected',
      });
      return;
    }

    // Topic scope for heteroIngest/heteroFinish. Prefer the explicit ingest
    // field, then a forwarded routing workspaceId, then the connection this
    // request arrived on (workspace enrollments). Older gateways omit both
    // payload fields; the workspace socket is still a reliable fallback.
    const workspaceId = request.ingestWorkspaceId ?? request.workspaceId ?? connectionWorkspaceId;
    const result = await this.agentRunHandler(
      workspaceId && workspaceId !== request.workspaceId ? { ...request, workspaceId } : request,
    );
    if (!executionCurrent(request)) return;
    client.sendAgentRunAck({
      attemptId: request.attemptId,
      operationId: request.operationId,
      ...result,
    });
  };

  // ─── Tool Call Routing ───

  handleToolCallRequest = async (request: ToolCallRequestMessage, client: GatewayClient) => {
    if (!executionCurrent(request)) return;
    const { requestId, toolCall } = request;
    const { apiName, arguments: argsStr, identifier, params, type } = toolCall;

    logger.info(
      `Received tool call: apiName=${apiName}, requestId=${requestId}, type=${type ?? 'tool'}`,
    );

    // Timed on THIS machine's clock, around both routes. The server can only
    // observe the whole dispatch round trip, so without this number a slow tool
    // and slow transport are indistinguishable — and desktop is where most
    // device tool calls actually happen, so leaving it out here would bias the
    // measurement toward the `lh connect` subset.
    const startedAt = performance.now();

    try {
      let result: ToolCallResult;

      if (type === 'mcp') {
        // Tunneled stdio MCP call: route to the local MCP client (spawns the
        // stdio server). Routing is driven by the explicit `type` discriminator,
        // not by sniffing the payload — the builtin local-system tool switch
        // keys on `apiName` and has no MCP server context.
        if (!this.mcpCallHandler) {
          throw new Error('No MCP call handler configured');
        }
        if (!params) {
          throw new Error('MCP tool call missing connection params');
        }
        result = await this.mcpCallHandler(
          { apiName, arguments: argsStr, identifier, params },
          request.executionSignal,
        );
      } else {
        if (!this.toolCallHandler) {
          throw new Error('No tool call handler configured');
        }
        const args = JSON.parse(argsStr);
        result = await this.toolCallHandler(identifier, apiName, args, request.executionSignal);
      }

      // Forward the typed envelope unchanged. Critically, do NOT stringify the
      // whole result into `content` — that would bury the structured payload
      // inside a JSON blob and lose `state`. The wire protocol carries each
      // field separately so downstream (`DeviceGateway` → `RuntimeExecutors`)
      // can persist `state` to `pluginState`. Optional fields are only set
      // when present so payloads stay minimal.
      const wireResult: ToolCallResponseMessage['result'] = {
        content: result.content,
        executionTimeMs: Math.round(performance.now() - startedAt),
        success: result.success,
      };
      const wireError = serializeWireError(result.error);
      if (wireError !== undefined) wireResult.error = wireError;
      if (result.state !== undefined) wireResult.state = result.state;

      if (!executionCurrent(request)) return;

      client.sendToolCallResponse({ attemptId: request.attemptId, requestId, result: wireResult });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Tool call failed: apiName=${apiName}, error=${errorMsg}`);

      if (!executionCurrent(request)) return;

      client.sendToolCallResponse({
        attemptId: request.attemptId,
        requestId,
        result: {
          content: errorMsg,
          error: errorMsg,
          // A failure is timed too: a tool that took 30s to fail is as
          // interesting as one that took 30s to succeed.
          executionTimeMs: Math.round(performance.now() - startedAt),
          success: false,
        },
      });
    }
  };

  // ─── Message API Routing ───

  handleMessageApiRequest = async (request: MessageApiRequestMessage, client: GatewayClient) => {
    if (!executionCurrent(request)) return;
    const { requestId, api } = request;
    const { apiName, payload, platform } = api;

    logger.info(
      `Received message API request: platform=${platform}, apiName=${apiName}, requestId=${requestId}`,
    );

    try {
      if (!this.messageApiHandler) {
        throw new Error('No message API handler configured');
      }

      const result = await this.messageApiHandler(
        platform,
        apiName,
        payload,
        request.executionSignal,
      );

      if (!executionCurrent(request)) return;

      client.sendMessageApiResponse({
        attemptId: request.attemptId,
        requestId,
        result: {
          content: typeof result === 'string' ? result : JSON.stringify(result),
          success: true,
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        `Message API request failed: platform=${platform}, apiName=${apiName}, error=${errorMsg}`,
      );

      if (!executionCurrent(request)) return;

      client.sendMessageApiResponse({
        attemptId: request.attemptId,
        requestId,
        result: {
          content: errorMsg,
          error: errorMsg,
          success: false,
        },
      });
    }
  };
}
