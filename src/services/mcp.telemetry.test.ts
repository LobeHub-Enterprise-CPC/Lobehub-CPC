import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockElectronIpc = vi.hoisted(() => ({ mcp: { callTool: vi.fn() } }));
const reportPluginCall = vi.hoisted(() => vi.fn());
const connectorCallTool = vi.hoisted(() => vi.fn());
const connectorState = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@lobechat/const', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  CURRENT_VERSION: '1.0.0',
  isDesktop: true,
}));

vi.mock('@lobechat/utils', () => ({
  isLocalOrPrivateUrl: vi.fn(() => false),
  safeParseJSON: vi.fn((str: string) => {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }),
}));

vi.mock('@lobechat/utils/mcpIpcPayload', () => ({
  deserializeMcpIpcPayload: (value: unknown) => value,
  serializeMcpIpcPayload: (value: unknown) => value,
}));

vi.mock('@/libs/trpc/client', () => ({
  lambdaClient: { connector: { callTool: { mutate: connectorCallTool } } },
  toolsClient: {
    market: { callCloudMcpEndpoint: { mutate: vi.fn() } },
    mcp: { callTool: { mutate: vi.fn() } },
  },
}));

vi.mock('@/utils/electron/ipc', () => ({ ensureElectronIpc: () => mockElectronIpc }));

vi.mock('./discover', () => ({
  discoverService: {
    reportPluginCall,
    safeInjectMPToken: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockPlugin = {
  customParams: { mcp: { command: 'npx', name: 'local-plugin', type: 'stdio' } },
  manifest: { meta: { title: 'Local' }, version: '1.0.0' },
};

vi.mock('@/store/tool/store', () => ({ getToolStoreState: () => ({}) }));
vi.mock('@/store/tool/selectors', () => ({
  pluginSelectors: {
    getCustomPluginById: () => () => null,
    getInstalledPluginById: () => () => mockPlugin,
  },
}));
vi.mock('@/store/tool/slices/connector/selectors', () => ({
  connectorSelectors: { connectorByIdentifier: () => () => connectorState.current },
}));

const payload = (id = 'call-1') =>
  ({
    apiName: 'run',
    arguments: '{"secret":"private words"}',
    id,
    identifier: 'local-plugin',
    type: 'standalone',
  }) as never;

const reported = () => reportPluginCall.mock.calls.map(([report]) => report);

beforeEach(() => {
  vi.clearAllMocks();
  reportPluginCall.mockResolvedValue(undefined);
  connectorState.current = undefined;
});

describe('MCPService desktop stdio telemetry', () => {
  const run = async (id?: string) => {
    const { mcpService } = await import('./mcp');
    return mcpService.invokeMcpToolCall(payload(id), { topicId: 'topic-1' });
  };

  it('reports through the shared boundary with the outcome fixed when the call ended', async () => {
    mockElectronIpc.mcp.callTool.mockResolvedValue({ content: 'ok', state: {}, success: true });

    await run();

    expect(reportPluginCall).toHaveBeenCalledTimes(1);
    expect(reported()[0].execution).toMatchObject({
      attempt: 1,
      durationMs: expect.any(Number),
      eventId: expect.stringMatching(/^v1:call:.+:1$/),
      eventType: 'call',
      occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      success: true,
    });
    expect(reported()[0]).toMatchObject({ identifier: 'local-plugin', methodName: 'run' });
  });

  it('makes two invocations of the same tool call two events', async () => {
    mockElectronIpc.mcp.callTool.mockResolvedValue({ content: 'ok', state: {}, success: true });

    await run('call-1');
    await run('call-1');

    const ids = reported().map((report) => report.execution.eventId);
    expect(new Set(ids).size).toBe(2);
  });

  it('reports a thrown call as a failure and still throws it', async () => {
    mockElectronIpc.mcp.callTool.mockRejectedValue(new Error('spawn failed'));

    await expect(run()).rejects.toThrow('spawn failed');

    expect(reported()[0].execution).toMatchObject({ errorCode: 'CALL_FAILED', success: false });
  });

  it.each([
    ['a failed result', { content: 'x', state: {}, success: false }],
    ['an isError result', { content: 'x', state: { isError: true }, success: true }],
  ])('reports %s as a failure although the call returned', async (_label, result) => {
    mockElectronIpc.mcp.callTool.mockResolvedValue(result);

    await run();

    expect(reported()[0].execution.success).toBe(false);
  });

  it('keeps what the tool was given out of the report', async () => {
    mockElectronIpc.mcp.callTool.mockResolvedValue({ content: 'ok', state: {}, success: true });

    await run();

    expect(JSON.stringify(reported()[0])).not.toContain('private words');
    expect(reported()[0].requestSizeBytes).toEqual(expect.any(Number));
  });
});

describe('MCPService server-side reporting', () => {
  it('gives the server the id of this invocation so its report can be told from a repeat', async () => {
    const { toolsClient } = await import('@/libs/trpc/client');
    mockPlugin.customParams.mcp = { name: 'remote', type: 'http' } as never;
    vi.mocked(toolsClient.mcp.callTool.mutate).mockResolvedValue({ content: 'ok' } as never);
    const { mcpService } = await import('./mcp');

    await mcpService.invokeMcpToolCall(payload('call-1'), {});
    await mcpService.invokeMcpToolCall(payload('call-1'), {});

    const [first, second] = vi
      .mocked(toolsClient.mcp.callTool.mutate)
      .mock.calls.map(([input]) => (input as any).meta.executionId);
    expect(first).toEqual(expect.any(String));
    expect(first).not.toBe(second);
    expect(reportPluginCall).not.toHaveBeenCalled();
  });
});

// A connected MCP is executed by `connector.callTool` on the server, which owns
// the report for it. The client only names the invocation, so a retry of the
// request is the same event, and does not report a second time itself.
describe('MCPService connector route telemetry', () => {
  const run = async () => {
    const { mcpService } = await import('./mcp');
    return mcpService.invokeMcpToolCall(payload(), { topicId: 'topic-1' });
  };

  beforeEach(() => {
    connectorState.current = {
      isEnabled: true,
      mcpConnectionType: 'http',
      mcpServerUrl: 'https://mcp.test/x',
    };
    connectorCallTool.mockResolvedValue({ content: 'ok', success: true });
  });

  it('hands the server a stable id for the invocation and reports nothing itself', async () => {
    await run();

    expect(connectorCallTool).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: expect.any(String), identifier: 'local-plugin' }),
      expect.anything(),
    );
    expect(reportPluginCall).not.toHaveBeenCalled();
  });

  it('names every invocation of the same tool call differently', async () => {
    await run();
    await run();

    const ids = connectorCallTool.mock.calls.map(([input]) => input.executionId);
    expect(new Set(ids).size).toBe(2);
  });

  it('still reports nothing itself when the server call fails', async () => {
    connectorCallTool.mockRejectedValue(new Error('server down'));

    await expect(run()).rejects.toThrow('server down');
    expect(reportPluginCall).not.toHaveBeenCalled();
  });
});
