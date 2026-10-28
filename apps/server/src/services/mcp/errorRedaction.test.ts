import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { debugLog } = vi.hoisted(() => ({ debugLog: vi.fn() }));

vi.mock('debug', () => ({ default: () => debugLog }));
vi.mock('@/libs/mcp');

const CANARY = {
  access: 'ACCESSCANARY',
  header: 'HEADERCANARY',
  pass: 'PASSCANARY',
  query: 'QUERYCANARY',
  refresh: 'REFRESHCANARY',
  token: 'TOKENCANARY',
};

const URL_WITH_SECRETS = `https://user:${CANARY.pass}@mcp.example.com/mcp?apikey=${CANARY.query}`;

const chain = (error: unknown): string => {
  const out: string[] = [];
  let current: any = error;
  for (let i = 0; current && i < 10; i++) {
    out.push(String(current.message), String(current.stack), JSON.stringify(current.data ?? ''));
    current = current.cause;
  }
  return out.join('\n');
};

const dump = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls
    .flat()
    .map((arg) => {
      if (arg instanceof Error) return chain(arg);
      try {
        return typeof arg === 'string' ? arg : JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join('\n');

const expectNoCanaries = (text: string) => {
  for (const canary of Object.values(CANARY)) expect(text).not.toContain(canary);
};

describe('MCPService error redaction', () => {
  let mcpService: any;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let MCPClient: any;

  const leakyError = () =>
    new Error(
      `Fetch failed: request to ${URL_WITH_SECRETS} failed, reason: Client network socket disconnected ` +
        `before secure TLS connection was established (Authorization: Bearer ${CANARY.token}, X-Key: ${CANARY.header})`,
      {
        cause: new Error(
          `request to ${URL_WITH_SECRETS} failed (refresh ${CANARY.refresh}, access ${CANARY.access})`,
        ),
      },
    );

  const auth = {
    accessToken: CANARY.access,
    refreshToken: CANARY.refresh,
    token: CANARY.token,
    type: 'oauth2' as const,
  };
  const headers = { 'X-Key': CANARY.header };

  beforeEach(async () => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    ({ MCPClient } = await import('@/libs/mcp'));
    const { MCPService } = await import('./index');
    mcpService = new MCPService();
  });

  it('client initialization failure: logs and the thrown TRPCError carry no secret', async () => {
    vi.mocked(MCPClient).mockImplementation(function () {
      return { initialize: vi.fn().mockRejectedValue(leakyError()) } as any;
    });

    const thrown: any = await mcpService
      .getStreamableMcpServerManifest(
        'srv',
        URL_WITH_SECRETS,
        undefined,
        { ...auth, type: 'bearer' },
        headers,
      )
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(TRPCError);
    // the UI message stays useful: sanitized URL and the underlying reason
    expect(thrown.message).toContain('mcp.example.com/mcp?apikey=');
    expect(thrown.message).toContain('Client network socket disconnected');
    expectNoCanaries(chain(thrown));
    expect(consoleError).toHaveBeenCalled();
    expectNoCanaries(dump(consoleError));
    expectNoCanaries(dump(debugLog));
  });

  it('errors carrying structured `data` keep their TRPC code but lose secrets', async () => {
    const withData = Object.assign(leakyError(), {
      data: { message: `bad ${URL_WITH_SECRETS}`, metadata: { originalError: CANARY.header } },
    });
    vi.mocked(MCPClient).mockImplementation(function () {
      return { initialize: vi.fn().mockRejectedValue(withData) } as any;
    });

    const thrown: any = await mcpService
      .listTools({ auth, headers, name: 'srv', type: 'http', url: URL_WITH_SECRETS })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(TRPCError);
    expect(thrown.code).toBe('SERVICE_UNAVAILABLE');
    expectNoCanaries(chain(thrown));
    expectNoCanaries(dump(consoleError));
    expectNoCanaries(dump(debugLog));
  });

  it('operation failures and pre-built TRPCErrors are scrubbed before leaving the service', async () => {
    vi.spyOn(mcpService as any, 'getClient').mockResolvedValue({
      listTools: vi.fn().mockRejectedValue(
        new TRPCError({
          cause: leakyError(),
          code: 'BAD_GATEWAY',
          message: leakyError().message,
        }),
      ),
    });

    const thrown: any = await mcpService
      .listTools({ auth, headers, name: 'srv', type: 'http', url: URL_WITH_SECRETS })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(TRPCError);
    expect(thrown.code).toBe('BAD_GATEWAY');
    expectNoCanaries(chain(thrown));
    expectNoCanaries(dump(consoleError));
    expectNoCanaries(dump(debugLog));
  });

  it('stdio env values and secret args are scrubbed from errors', async () => {
    vi.spyOn(mcpService as any, 'getClient').mockResolvedValue({
      listTools: vi
        .fn()
        .mockRejectedValue(new Error(`spawn failed: ${CANARY.header} / --token ${CANARY.token}`)),
    });

    const thrown: any = await mcpService
      .listTools({
        args: ['--token', CANARY.token],
        command: 'npx',
        env: { API_KEY: CANARY.header },
        name: 'srv',
        type: 'stdio',
      })
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(TRPCError);
    expectNoCanaries(chain(thrown));
    expectNoCanaries(dump(consoleError));
  });
});
