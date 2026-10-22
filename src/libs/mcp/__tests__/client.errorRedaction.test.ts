import { describe, expect, it, vi } from 'vitest';

import { MCPClient } from '../index';

const { debugLog } = vi.hoisted(() => ({ debugLog: vi.fn() }));

vi.mock('debug', () => ({ default: () => debugLog }));

const CANARY = {
  header: 'HEADERCANARY',
  pass: 'PASSCANARY',
  query: 'QUERYCANARY',
  token: 'TOKENCANARY',
};

const chain = (error: unknown): string => {
  const out: string[] = [];
  let current: any = error;
  for (let i = 0; current && i < 10; i++) {
    out.push(String(current.message), String(current.stack));
    current = current.cause;
  }
  return out.join('\n');
};

const dump = (calls: unknown[][]) =>
  calls
    .flat()
    .map((arg) => (arg instanceof Error ? chain(arg) : String(arg)))
    .join('\n');

describe('MCPClient connect failure redaction', () => {
  it('neither logs nor rethrows credentials when the HTTP request itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // `.invalid` never resolves (RFC 6761), so the real SSRF-safe fetch fails with a
    // "request to <url> failed" error that embeds the full URL.
    const client = new MCPClient({
      auth: { token: CANARY.token, type: 'bearer' },
      headers: { 'X-Key': CANARY.header },
      name: 'unreachable',
      type: 'http',
      url: `https://user:${CANARY.pass}@mcp-canary.invalid/mcp?apikey=${CANARY.query}`,
    });

    const thrown = await client.initialize().catch((e) => e);

    expect(thrown).toBeInstanceOf(Error);
    expect(chain(thrown)).toContain('mcp-canary.invalid/mcp');
    for (const output of [
      chain(thrown),
      dump(consoleError.mock.calls),
      dump(debugLog.mock.calls),
    ]) {
      for (const canary of Object.values(CANARY)) expect(output).not.toContain(canary);
    }
    consoleError.mockRestore();
  }, 30_000);
});
