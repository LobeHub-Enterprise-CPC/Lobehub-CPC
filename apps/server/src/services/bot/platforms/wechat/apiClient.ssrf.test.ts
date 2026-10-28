// @vitest-environment node
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWechatApiClient } from './apiClient';

/**
 * `baseUrl` is part of the bot credentials a user submits when connecting a bot
 * (the credentials record accepts any key), so the iLink API host is user input.
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
    // Defer the failure by a tick: the default host is https, and an 'error' event emitted
    // before the TLS socket has its listeners surfaces as an unhandled error, not a failed request.
    process.nextTick(() => this.destroy(new Error('network disabled in test')));
    return this;
  } as any);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createWechatApiClient', () => {
  it.each(['http://169.254.169.254', 'http://127.0.0.1:6379', 'http://10.0.0.8'])(
    'does not poll a user-provided iLink host %s',
    async (baseUrl) => {
      const api = createWechatApiClient('bot-token', 'bot-id', baseUrl);

      await expect(api.getUpdates()).rejects.toBeDefined();

      expect(connectTargets).toEqual([]);
    },
  );

  it('keeps the default iLink host on the plain transport', async () => {
    const api = createWechatApiClient('bot-token', 'bot-id');

    await expect(api.getUpdates()).rejects.toBeDefined();

    expect(connectTargets.length).toBeGreaterThan(0);
  });
});
