import { afterEach, describe, expect, it, vi } from 'vitest';

import type { App } from '@/core/App';

import type { MCPClient } from '../libs/mcp/client';
import McpCtr from './McpCtr';

vi.mock('../libs/mcp/client', () => ({
  MCPConnectionError: class extends Error {
    stderrLogs: string[] = [];
  },
}));
afterEach(() => vi.restoreAllMocks());

describe('desktop MCP preparation execution boundary', () => {
  it('does not call a tool if its authority is revoked while connecting, and keeps the pooled session', async () => {
    const controller = new McpCtr({} as App);
    let ready!: (client: MCPClient) => void;
    vi.spyOn(
      controller as unknown as { createClient: () => Promise<MCPClient> },
      'createClient',
    ).mockImplementation(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    const callTool = vi.fn();
    const disconnect = vi.fn();
    const authority = new AbortController();
    const pending = controller.runStdioMcpTool(
      { args: '{}', env: {}, params: { command: 'TEST-ONLY', name: 'fixture' }, toolName: 'write' },
      authority.signal,
    );
    authority.abort(new Error('GATEWAY_EXECUTION_STALE'));
    ready({ callTool, disconnect } as unknown as MCPClient);
    await expect(pending).rejects.toThrow('GATEWAY_EXECUTION_STALE');
    expect(callTool).not.toHaveBeenCalled();
    // The session is pooled for the next authorized call; only this execution is refused.
    expect(disconnect).not.toHaveBeenCalled();
  });
});
