// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deviceGateway } from '@/server/services/deviceGateway';

import { ToolExecutionService } from '../index';

const { callCloudMcpEndpoint, getConnectorToolPermission, reportMarketTelemetry } = vi.hoisted(
  () => ({
    callCloudMcpEndpoint: vi.fn(),
    getConnectorToolPermission: vi.fn(),
    reportMarketTelemetry: vi.fn(),
  }),
);

vi.mock('@/libs/mcp/connectorPermissionCheck', () => ({
  buildBlockedToolResponse: (apiName: string) => ({
    content: `blocked ${apiName}`,
    error: { message: 'blocked', type: 'ToolDisabled' },
    success: false,
  }),
  getConnectorToolPermission,
}));

vi.mock('@/server/services/deviceGateway', () => ({
  deviceGateway: { executeMcpCall: vi.fn(), isConfigured: false },
}));
vi.mock('@/server/services/deviceGateway/dispatchAuthorization', () => ({
  resolveDeviceDispatchAuthorizationFailure: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/server/services/deviceGateway/scopedDevices', () => ({
  getScopedOnlineDevices: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../discover', () => ({
  DiscoverService: vi.fn(function () {
    return { callCloudMcpEndpoint };
  }),
}));
vi.mock('@/libs/trusted-client/resolveIdentity', () => ({
  resolveMarketServiceIdentity: vi.fn(async ({ userId }: { userId: string }) => ({ userId })),
}));
// The boundary under test is real; only delivery and the "after the response"
// hook are replaced.
vi.mock('@/server/services/marketTelemetry/reporter', () => ({
  reportMarketTelemetry,
}));
vi.mock('@/server/utils/scheduleAfterResponse', () => ({
  after: (work: () => unknown) => void work(),
}));

const reports = () =>
  reportMarketTelemetry.mock.calls.map(([report, context]) => ({
    body: report.body as Record<string, any>,
    context,
  }));

const callMcp = (
  mcpParams: Record<string, unknown> | undefined,
  options: {
    callTool?: ReturnType<typeof vi.fn>;
    context?: Record<string, unknown>;
    toolCallId?: string;
  } = {},
) => {
  const service = new ToolExecutionService({
    builtinToolsExecutor: {} as never,
    mcpService: { callTool: options.callTool ?? vi.fn() } as never,
  });

  return service.executeTool(
    {
      apiName: 'search',
      arguments: '{"q":"private words"}',
      id: options.toolCallId ?? 'call_1',
      identifier: 'github',
      type: 'mcp',
    } as never,
    {
      operationId: 'op_1',
      serverDB: {} as never,
      toolManifestMap: { github: { mcpParams, version: '1.4.0' } as never },
      userId: 'user_1',
      ...options.context,
    },
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  getConnectorToolPermission.mockResolvedValue(undefined);
  reportMarketTelemetry.mockResolvedValue({ attempts: 1, duplicate: false, status: 'delivered' });
  vi.mocked(deviceGateway).isConfigured = false;
});

describe('ToolExecutionService MCP telemetry boundary', () => {
  describe('event identity', () => {
    it('is the operation, the tool call and the retry loop attempt', async () => {
      callCloudMcpEndpoint.mockResolvedValue({ content: [] });

      await callMcp({ type: 'cloud' }, { context: { executionAttempt: 2 } });

      expect(reports()).toHaveLength(1);
      expect(reports()[0].body.eventId).toBe('v1:call:op_1:call_1:2');
    });

    it('is the same event when a redelivered step runs the same call again', async () => {
      callCloudMcpEndpoint.mockResolvedValue({ content: [] });

      await callMcp({ type: 'cloud' });
      await callMcp({ type: 'cloud' });

      const ids = reports().map(({ body }) => body.eventId);
      expect(ids[0]).toBe(ids[1]);
    });

    it('differs between two tool calls of one operation', async () => {
      callCloudMcpEndpoint.mockResolvedValue({ content: [] });

      await callMcp({ type: 'cloud' }, { toolCallId: 'call_1' });
      await callMcp({ type: 'cloud' }, { toolCallId: 'call_2' });

      const ids = reports().map(({ body }) => body.eventId);
      expect(new Set(ids).size).toBe(2);
    });

    it('differs between independent executions that cannot name themselves', async () => {
      callCloudMcpEndpoint.mockResolvedValue({ content: [] });

      await callMcp({ type: 'cloud' }, { context: { operationId: undefined } });
      await callMcp({ type: 'cloud' }, { context: { operationId: undefined } });

      const ids = reports().map(({ body }) => body.eventId);
      expect(new Set(ids).size).toBe(2);
    });
  });

  describe('the execution paths', () => {
    it('cloud: reports a success', async () => {
      callCloudMcpEndpoint.mockResolvedValue({ content: [{ text: 'ok', type: 'text' }] });

      await callMcp({ type: 'cloud' });

      expect(reports()[0].body).toMatchObject({
        identifier: 'github',
        metadata: { mcpType: 'cloud' },
        methodName: 'search',
        success: true,
        version: '1.4.0',
      });
    });

    it('cloud: a returned isError is a failure', async () => {
      callCloudMcpEndpoint.mockResolvedValue({
        content: [{ text: 'rate limited', type: 'text' }],
        isError: true,
      });

      await callMcp({ type: 'cloud' });

      expect(reports()[0].body).toMatchObject({ success: false });
    });

    it('cloud: a thrown error is a failure with the executor code', async () => {
      callCloudMcpEndpoint.mockRejectedValue(new Error('gateway down'));

      await callMcp({ type: 'cloud' });

      expect(reports()[0].body).toMatchObject({
        errorCode: 'CLOUD_MCP_EXECUTION_ERROR',
        success: false,
      });
    });

    it('http: reports a success', async () => {
      const callTool = vi.fn().mockResolvedValue({ content: 'ok', state: {}, success: true });

      await callMcp({ type: 'http', url: 'https://mcp.example.com' }, { callTool });

      expect(reports()[0].body).toMatchObject({ metadata: { mcpType: 'http' }, success: true });
    });

    // The executor wraps whatever the MCP client returns as a successful call.
    it('http: a result that says it is an error is a failure although the call returned', async () => {
      const callTool = vi.fn().mockResolvedValue({
        content: 'tool failed',
        state: { content: [], isError: true },
        success: false,
      });

      const result = await callMcp({ type: 'http', url: 'https://mcp.example.com' }, { callTool });

      expect(result.success).toBe(true);
      expect(reports()[0].body).toMatchObject({ success: false });
    });

    it('stdio: reports the command it ran, not its arguments', async () => {
      const callTool = vi.fn().mockResolvedValue({ content: 'ok', state: {}, success: true });

      await callMcp({ args: ['--api-key=hunter2'], command: 'npx', type: 'stdio' }, { callTool });

      expect(reports()[0].body.metadata).toMatchObject({ command: 'npx', mcpType: 'stdio' });
      expect(JSON.stringify(reports()[0].body)).not.toContain('hunter2');
    });

    it('device: reports a call tunnelled to the device', async () => {
      vi.mocked(deviceGateway).isConfigured = true;
      vi.mocked(deviceGateway.executeMcpCall).mockResolvedValue({
        content: 'ok',
        success: true,
      } as never);

      await callMcp({ command: 'npx', type: 'stdio' }, { context: { activeDeviceId: 'device-1' } });

      expect(reports()[0].body).toMatchObject({
        metadata: { mcpType: 'stdio', viaDevice: true },
        success: true,
      });
    });

    it('device: a failed device call is a failure', async () => {
      vi.mocked(deviceGateway).isConfigured = true;
      vi.mocked(deviceGateway.executeMcpCall).mockResolvedValue({
        content: 'device offline',
        error: 'DEVICE_OFFLINE',
        success: false,
      } as never);

      await callMcp({ command: 'npx', type: 'stdio' }, { context: { activeDeviceId: 'device-1' } });

      expect(reports()[0].body).toMatchObject({
        errorCode: 'MCP_DEVICE_EXECUTION_ERROR',
        metadata: { viaDevice: true },
        success: false,
      });
    });

    it('device-only with no reachable device: reports the failure it returned', async () => {
      vi.mocked(deviceGateway).isConfigured = true;

      await callMcp({ command: 'npx', type: 'stdio' });

      expect(reports()[0].body).toMatchObject({
        errorCode: 'MCP_DEVICE_UNAVAILABLE',
        success: false,
      });
    });

    it('a call that fails before it can run is still an execution that failed', async () => {
      await callMcp(undefined);

      expect(reports()[0].body).toMatchObject({
        errorCode: 'MCP_CONFIG_NOT_FOUND',
        success: false,
      });
    });
  });

  // The execution already has its identity when the permission gate answers, so
  // a call refused there is an execution that failed, not one that never was.
  describe('a call refused before it runs', () => {
    it('a tool the user disabled is a failed execution', async () => {
      getConnectorToolPermission.mockResolvedValue('disabled');
      const callTool = vi.fn();

      const result = await callMcp({ type: 'http' }, { callTool });

      expect(result.success).toBe(false);
      expect(callTool).not.toHaveBeenCalled();
      expect(reports()).toHaveLength(1);
      expect(reports()[0].body).toMatchObject({
        errorCode: 'TOOL_DISABLED',
        eventId: 'v1:call:op_1:call_1:1',
        identifier: 'github',
        methodName: 'search',
        success: false,
      });
    });

    it('a permission lookup that throws is reported as a failure and still throws', async () => {
      getConnectorToolPermission.mockRejectedValue(new Error('db down'));

      await expect(callMcp({ type: 'http' })).rejects.toThrow('db down');

      expect(reports()).toHaveLength(1);
      expect(reports()[0].body).toMatchObject({ success: false });
    });

    it('a builtin tool that is disabled reports nothing', async () => {
      getConnectorToolPermission.mockResolvedValue('disabled');
      const service = new ToolExecutionService({
        builtinToolsExecutor: { execute: vi.fn() },
        mcpService: {} as never,
      });

      await service.executeTool(
        {
          apiName: 'x',
          arguments: '{}',
          id: 'c',
          identifier: 'lobe-web',
          type: 'builtin',
        } as never,
        { operationId: 'op_1', serverDB: {} as never, toolManifestMap: {}, userId: 'user_1' },
      );

      expect(reportMarketTelemetry).not.toHaveBeenCalled();
    });
  });

  describe('what is and is not reported', () => {
    it('keeps the arguments and the result out of the report', async () => {
      callCloudMcpEndpoint.mockResolvedValue({
        content: [{ text: 'private answer', type: 'text' }],
      });

      await callMcp({ type: 'cloud' });

      const body = JSON.stringify(reports()[0].body);
      expect(body).not.toContain('private words');
      expect(body).not.toContain('private answer');
    });

    it('reports for the user and database of the run, without a bearer token to fall back on', async () => {
      callCloudMcpEndpoint.mockResolvedValue({ content: [] });
      const serverDB = {} as never;

      await callMcp({ type: 'cloud' }, { context: { serverDB } });

      expect(reports()[0].context).toEqual({ serverDB, userId: 'user_1' });
    });

    it('does not report anything for a builtin tool', async () => {
      const service = new ToolExecutionService({
        builtinToolsExecutor: {
          execute: vi.fn().mockResolvedValue({ content: 'x', success: true }),
        } as never,
        mcpService: {} as never,
      });

      await service.executeTool(
        {
          apiName: 'x',
          arguments: '{}',
          id: 'c',
          identifier: 'lobe-web',
          type: 'builtin',
        } as never,
        { toolManifestMap: {} },
      );

      expect(reportMarketTelemetry).not.toHaveBeenCalled();
    });

    it('does not let a failing report change the tool result', async () => {
      callCloudMcpEndpoint.mockResolvedValue({ content: [] });
      reportMarketTelemetry.mockRejectedValue(new Error('market down'));

      const result = await callMcp({ type: 'cloud' });

      expect(result.success).toBe(true);
    });
  });
});
