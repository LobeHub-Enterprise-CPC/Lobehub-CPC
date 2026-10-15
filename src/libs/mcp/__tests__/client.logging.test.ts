import { describe, expect, it, vi } from 'vitest';

import { MCPClient } from '../index';

const { debugLog } = vi.hoisted(() => ({ debugLog: vi.fn() }));

vi.mock('debug', () => ({ default: () => debugLog }));

const dump = () => JSON.stringify(debugLog.mock.calls);

describe('MCPClient debug logging', () => {
  it('does not print URL userinfo/query secrets or auth/header values for http transport', () => {
    debugLog.mockClear();

    new MCPClient({
      auth: { accessToken: 'SECRET_ACCESS', type: 'oauth2' },
      headers: { 'X-Api-Key': 'SECRET_HEADER' },
      name: 'http',
      type: 'http',
      url: 'https://user:SECRET_PASS@mcp.example.com/mcp?api_key=SECRET_QUERY',
    });

    const output = dump();
    expect(output).toContain('mcp.example.com/mcp');
    for (const secret of ['SECRET_PASS', 'SECRET_QUERY', 'SECRET_ACCESS', 'SECRET_HEADER']) {
      expect(output).not.toContain(secret);
    }
  });

  it('does not print secret-looking stdio args', () => {
    debugLog.mockClear();

    new MCPClient({
      args: ['server.js', '--api-key', 'SECRET_ARG', '--token=SECRET_EQ'],
      command: 'node',
      name: 'stdio',
      type: 'stdio',
    });

    const output = dump();
    expect(output).toContain('server.js');
    expect(output).not.toContain('SECRET_ARG');
    expect(output).not.toContain('SECRET_EQ');
  });
});
