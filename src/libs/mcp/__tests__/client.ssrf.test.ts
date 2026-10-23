// @vitest-environment node
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MCPClient } from '../client';

/**
 * MCP server URLs are typed in by users (custom plugins, connectors), and the
 * server connects to them from the app server.
 */
const connectTargets: string[] = [];

beforeEach(() => {
  connectTargets.length = 0;
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: any[]
  ) {
    // net.connect() hands the normalized `[options, cb]` pair through as one array.
    const [first] = Array.isArray(args[0]) ? args[0] : args;
    connectTargets.push(`${first?.host}:${first?.port}`);
    setImmediate(() => this.destroy(new Error('network disabled in test')));
    return this;
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS;
});

describe('MCPClient http transport', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://127.0.0.1:6379/mcp',
    'http://10.0.0.8/mcp',
    'http://192.168.1.10:3000/mcp',
  ])('never connects to a user-provided MCP server at %s', async (url) => {
    const client = new MCPClient({
      auth: { token: 'user-bearer', type: 'bearer' },
      name: 'evil',
      type: 'http',
      url,
    });

    await expect(client.initialize()).rejects.toBeDefined();

    expect(connectTargets).toEqual([]);
  });

  it('lets the deployment opt in to a private MCP server', async () => {
    process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS = '1';
    const client = new MCPClient({ name: 'internal', type: 'http', url: 'http://10.0.0.8/mcp' });

    await expect(client.initialize()).rejects.toBeDefined();

    expect(connectTargets).toContain('10.0.0.8:80');
  });
});
