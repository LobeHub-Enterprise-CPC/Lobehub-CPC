import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { debugLog } = vi.hoisted(() => ({ debugLog: vi.fn() }));

vi.mock('debug', () => ({ default: () => debugLog }));
vi.mock('@/libs/mcp');
vi.mock('./deps', () => ({
  mcpSystemDepsCheckService: {
    checkDeployOption: vi.fn().mockResolvedValue({ allDependenciesMet: true, isRecommended: true }),
  },
}));

const SECRETS = {
  accessToken: 'oat_SECRET_ACCESS_TOKEN',
  bearerToken: 'bearer_SECRET_TOKEN',
  clientSecret: 'SECRET_CLIENT_SECRET',
  headerValue: 'Bearer SECRET_HEADER_VALUE',
  refreshToken: 'SECRET_REFRESH_TOKEN',
  stdioEnv: 'SECRET_STDIO_ENV',
  urlQuery: 'SECRET_URL_QUERY',
  urlUserinfo: 'SECRET_URL_PASSWORD',
};

const dump = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls
    .map((args) =>
      args
        .map((arg) => {
          if (arg instanceof Error) return `${arg.message}\n${arg.stack}`;
          try {
            return typeof arg === 'string' ? arg : JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(' '),
    )
    .join('\n');

const expectNoSecrets = (output: string) => {
  for (const secret of Object.values(SECRETS)) expect(output).not.toContain(secret);
};

describe('MCPService logging never leaks credentials', () => {
  let mcpService: any;
  let mockClient: any;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { mcpService: importedService } = await import('./index');
    mcpService = importedService;

    mockClient = {
      callTool: vi.fn(),
      listPrompts: vi.fn(),
      listResources: vi.fn(),
      listTools: vi.fn(),
    };
    vi.spyOn(mcpService as any, 'getClient').mockResolvedValue(mockClient);
  });

  const httpParams = (auth: Record<string, unknown>, headers?: Record<string, string>) => ({
    auth,
    headers,
    name: 'clerk-oauth',
    type: 'http' as const,
    url: `https://user:${SECRETS.urlUserinfo}@mcp.example.com/mcp?api_key=${SECRETS.urlQuery}`,
  });

  const oauth2 = {
    accessToken: SECRETS.accessToken,
    clientId: undefined,
    clientSecret: SECRETS.clientSecret,
    refreshToken: SECRETS.refreshToken,
    tokenExpiresAt: 1_800_000_000_000,
    type: 'oauth2',
  };

  const cases: Array<[string, ReturnType<typeof httpParams>]> = [
    ['oauth2 auth', httpParams(oauth2)],
    ['bearer auth', httpParams({ token: SECRETS.bearerToken, type: 'bearer' })],
    [
      'custom headers',
      httpParams({ type: 'none' }, { 'Authorization': SECRETS.headerValue, 'X-Trace': 'abc' }),
    ],
  ];

  it.each(cases)('withSessionRetry failure path with %s', async (_name, params) => {
    mockClient.listTools.mockRejectedValue(new Error('Streamable HTTP error: 500'));

    await expect(mcpService.listTools(params)).rejects.toThrow(TRPCError);

    // the failure was actually logged (otherwise the assertions below are vacuous)
    expect(consoleError).toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalled();
    expectNoSecrets(dump(consoleError));
    expectNoSecrets(dump(debugLog));
  });

  it('keeps diagnostic shape (name, type, auth type, header names, url host/path)', async () => {
    mockClient.listTools.mockRejectedValue(new Error('boom'));

    await expect(mcpService.listTools(cases[2][1])).rejects.toThrow(TRPCError);

    const output = dump(consoleError);
    expect(output).toContain('clerk-oauth');
    expect(output).toContain('Authorization');
    expect(output).toContain('mcp.example.com/mcp');
  });

  it('does not leak on the successful debug path either', async () => {
    mockClient.listTools.mockResolvedValue([]);

    await mcpService.listTools(httpParams(oauth2, { Authorization: SECRETS.headerValue }));

    expect(debugLog).toHaveBeenCalled();
    expectNoSecrets(dump(debugLog));
  });

  it('does not leak stdio env values', async () => {
    mockClient.listTools.mockRejectedValue(new Error('boom'));

    await expect(
      mcpService.listTools({
        args: ['--api-key', SECRETS.stdioEnv, `--token=${SECRETS.stdioEnv}`],
        command: 'npx',
        env: { API_KEY: SECRETS.stdioEnv },
        name: 'stdio-mcp',
        type: 'stdio',
      }),
    ).rejects.toThrow(TRPCError);

    expectNoSecrets(dump(consoleError));
    expectNoSecrets(dump(debugLog));
  });

  it('does not leak credentials from the getClient initialization error path', async () => {
    const { MCPClient } = await import('@/libs/mcp');
    vi.mocked(MCPClient).mockImplementation(function () {
      return { initialize: vi.fn().mockRejectedValue(new Error('connect failed')) } as any;
    });
    (mcpService.getClient as any).mockRestore();
    const params = httpParams(oauth2, { Authorization: SECRETS.headerValue });

    await expect(mcpService.listTools(params)).rejects.toThrow('connect failed');

    expect(
      debugLog.mock.calls.some(([msg]) => String(msg).includes('Detailed initialization')),
    ).toBe(true);
    expectNoSecrets(dump(consoleError));
    expectNoSecrets(dump(debugLog));
  });

  it('does not leak the client cache key', async () => {
    const { MCPClient } = await import('@/libs/mcp');
    vi.mocked(MCPClient).mockImplementation(function () {
      return { initialize: vi.fn().mockResolvedValue(undefined) } as any;
    });
    (mcpService.getClient as any).mockRestore();

    // sorted-key JSON puts `headers` first, so a raw key prefix would expose short values
    await mcpService.getClient({
      headers: { K: 'SHORT' },
      name: 'headers-first',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
    });

    expect(debugLog.mock.calls.some(([msg]) => String(msg).includes('key fingerprint'))).toBe(true);
    expect(dump(debugLog)).not.toContain('"K"');
    expect(dump(debugLog)).not.toContain('SHORT');
  });

  it('does not leak credentials in checkMcpInstall deployment option logging', async () => {
    await mcpService.checkMcpInstall({
      deploymentOptions: [
        {
          connection: {
            auth: oauth2,
            env: { API_KEY: SECRETS.stdioEnv },
            headers: { Authorization: SECRETS.headerValue },
            type: 'http',
            url: `https://mcp.example.com/mcp?token=${SECRETS.urlQuery}`,
          },
        },
      ],
    });

    expect(debugLog).toHaveBeenCalled();
    expectNoSecrets(dump(debugLog));
    expectNoSecrets(dump(consoleError));
  });
});
