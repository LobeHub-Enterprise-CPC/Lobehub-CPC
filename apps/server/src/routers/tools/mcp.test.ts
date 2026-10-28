// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mcpRouter } from './mcp';

const { callTool, queryByConnector, queryByIdentifiers, reportMarketTelemetry } = vi.hoisted(
  () => ({
    callTool: vi.fn(),
    queryByConnector: vi.fn(),
    queryByIdentifiers: vi.fn(),
    reportMarketTelemetry: vi.fn(),
  }),
);

// Stdio runs only on the desktop build.
vi.mock('@lobechat/const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isDesktop: false,
}));
vi.mock('@/libs/trpc/lambda/middleware', () => ({
  serverDatabase: vi.fn(function (opts: any) {
    return opts.next({ ctx: opts.ctx });
  }),
  telemetry: vi.fn(function (opts: any) {
    return opts.next({ ctx: opts.ctx });
  }),
}));
vi.mock('@/database/models/connector', () => ({
  ConnectorModel: vi.fn(function () {
    return { queryByIdentifiers };
  }),
}));
vi.mock('@/database/models/connectorTool', () => ({
  ConnectorToolModel: vi.fn(function () {
    return { queryByConnector };
  }),
}));
vi.mock('@/server/services/file', () => ({
  FileService: vi.fn(function () {
    return {};
  }),
}));
vi.mock('@/server/services/mcp', () => ({ mcpService: { callTool } }));
vi.mock('@/server/services/mcp/contentProcessor', () => ({ processContentBlocks: vi.fn() }));
vi.mock('@/server/services/marketTelemetry/reporter', () => ({ reportMarketTelemetry }));
vi.mock('@/server/utils/scheduleAfterResponse', () => ({
  after: (work: () => unknown) => void work(),
}));

const http = { auth: { type: 'none' }, name: 'github', type: 'http', url: 'https://mcp.test/x' };
const stdio = { args: [], command: 'npx', name: 'local', type: 'stdio' };

const call = (params: Record<string, unknown>, executionId = 'inv-1') =>
  mcpRouter.createCaller({ serverDB: {}, userId: 'user_1' } as any).callTool({
    args: '{"q":"secret"}',
    meta: { executionId },
    params: params as any,
    toolName: 'search',
  });

const reports = () =>
  reportMarketTelemetry.mock.calls.map(([report]) => report.body as Record<string, any>);

beforeEach(() => {
  vi.clearAllMocks();
  reportMarketTelemetry.mockResolvedValue({ attempts: 1, duplicate: false, status: 'delivered' });
  queryByIdentifiers.mockResolvedValue([]);
  queryByConnector.mockResolvedValue([]);
});

describe('mcpRouter.callTool telemetry', () => {
  it('reports a call that ran', async () => {
    callTool.mockResolvedValue({ content: 'ok', success: true });

    await call(http);

    expect(reports()).toHaveLength(1);
    expect(reports()[0]).toMatchObject({
      eventId: 'v1:call:inv-1:1',
      identifier: 'github',
      methodName: 'search',
      success: true,
    });
  });

  // The execution has its identity as soon as the request is in; a refusal is
  // an execution that failed, and is reported as one.
  describe('a call refused before it runs', () => {
    it('stdio outside the desktop build', async () => {
      await expect(call(stdio)).rejects.toThrow('Stdio MCP type is not supported');

      expect(callTool).not.toHaveBeenCalled();
      expect(reports()).toHaveLength(1);
      expect(reports()[0]).toMatchObject({
        eventId: 'v1:call:inv-1:1',
        identifier: 'local',
        success: false,
      });
    });

    it('a tool the user disabled', async () => {
      queryByIdentifiers.mockResolvedValue([{ id: 'c1' }]);
      queryByConnector.mockResolvedValue([{ permission: 'disabled', toolName: 'search' }]);

      await call(http);

      expect(callTool).not.toHaveBeenCalled();
      expect(reports()).toHaveLength(1);
      expect(reports()[0]).toMatchObject({
        errorCode: 'TOOL_DISABLED',
        eventId: 'v1:call:inv-1:1',
        success: false,
      });
    });

    it('a permission lookup that throws', async () => {
      queryByIdentifiers.mockRejectedValue(new Error('db down'));

      await expect(call(http)).rejects.toThrow('db down');

      expect(callTool).not.toHaveBeenCalled();
      expect(reports()).toHaveLength(1);
      expect(reports()[0]).toMatchObject({ success: false });
    });
  });
});
