// @vitest-environment node
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpenai } from './createOpenai';

/** The endpoint comes from a request header, i.e. straight from the caller. */
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
    this.destroy(new Error('network disabled in test'));
    return this;
  } as any);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENAI_PROXY_URL;
});

describe('createOpenai', () => {
  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://127.0.0.1:8080/v1',
    'http://10.0.0.8/v1',
  ])('never connects to a caller-provided endpoint %s', async (endpoint) => {
    const openai = createOpenai('user-key', endpoint);

    await expect(openai.models.list()).rejects.toBeDefined();

    expect(connectTargets).toEqual([]);
  });

  it('keeps the platform OPENAI_PROXY_URL on the plain transport', async () => {
    process.env.OPENAI_PROXY_URL = 'http://127.0.0.1:18080/v1';
    const openai = createOpenai('user-key');

    await expect(openai.models.list()).rejects.toBeDefined();

    expect(connectTargets).toContain('127.0.0.1:18080');
  });
});
