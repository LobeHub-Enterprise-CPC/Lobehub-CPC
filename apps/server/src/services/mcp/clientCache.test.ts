import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/libs/mcp');
// Stdio clients only exist in the desktop build; the service refuses them elsewhere.
vi.mock('@lobechat/const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isDesktop: true,
}));

describe('MCPService client cache', () => {
  let mcpService: any;
  let MCPClient: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ MCPClient } = await import('@/libs/mcp'));
    vi.mocked(MCPClient).mockImplementation(function () {
      return { initialize: vi.fn().mockResolvedValue(undefined) } as any;
    });
    // fresh service instance => empty cache
    const { MCPService } = await import('./index');
    mcpService = new MCPService();
  });

  const stdio = (args: string[], extra: Record<string, unknown> = {}) => ({
    args,
    command: 'npx',
    name: 'srv',
    type: 'stdio' as const,
    ...extra,
  });

  it('reuses one client for identical params', async () => {
    const a = await mcpService.getClient(stdio(['-y', 'pkg', '--token', 'u1']));
    const b = await mcpService.getClient(stdio(['-y', 'pkg', '--token', 'u1']));

    expect(a).toBe(b);
    expect(MCPClient).toHaveBeenCalledTimes(1);
  });

  it('creates separate clients when stdio params differ only in args', async () => {
    const a = await mcpService.getClient(stdio(['-y', 'pkg', '--token', 'u1']));
    const b = await mcpService.getClient(stdio(['-y', 'pkg', '--token', 'u2']));

    expect(a).not.toBe(b);
    expect(MCPClient).toHaveBeenCalledTimes(2);
  });

  it('treats the same args in a different order as different params', async () => {
    const a = await mcpService.getClient(stdio(['a', 'b']));
    const b = await mcpService.getClient(stdio(['b', 'a']));

    expect(a).not.toBe(b);
    expect(MCPClient).toHaveBeenCalledTimes(2);
  });

  it('is insensitive to key order inside env / headers / auth objects', async () => {
    const a = await mcpService.getClient(stdio(['x'], { env: { A: '1', B: '2' } }));
    const b = await mcpService.getClient(stdio(['x'], { env: { B: '2', A: '1' } }));
    expect(a).toBe(b);

    const http = (headers: Record<string, string>, auth: Record<string, unknown>) => ({
      auth,
      headers,
      name: 'h',
      type: 'http' as const,
      url: 'https://mcp.example.com/mcp',
    });
    const c = await mcpService.getClient(http({ A: '1', B: '2' }, { token: 't', type: 'bearer' }));
    const d = await mcpService.getClient(http({ B: '2', A: '1' }, { type: 'bearer', token: 't' }));
    expect(c).toBe(d);
  });

  it('separates clients whose headers or auth values differ', async () => {
    const http = (token: string) => ({
      auth: { token, type: 'bearer' },
      name: 'h',
      type: 'http' as const,
      url: 'https://mcp.example.com/mcp',
    });

    const a = await mcpService.getClient(http('t1'));
    const b = await mcpService.getClient(http('t2'));

    expect(a).not.toBe(b);
  });
});
