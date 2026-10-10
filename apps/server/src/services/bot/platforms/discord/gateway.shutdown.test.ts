// @vitest-environment node
import { createRequire } from 'node:module';

import { createDiscordAdapter } from '@chat-adapter/discord';
import { describe, expect, it, vi } from 'vitest';

const { Client } = createRequire(import.meta.resolve('@chat-adapter/discord'))('discord.js');
const state = { client: undefined as any, destroy: undefined as any };

describe('Discord SDK shutdown receipt', () => {
  it('waits for admitted forwarding and asynchronous socket destruction', async () => {
    let destroyed!: () => void;
    let forwarded!: () => void;
    state.destroy = vi.spyOn(Client.prototype, 'destroy').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          destroyed = resolve;
        }),
    );
    vi.spyOn(Client.prototype, 'login').mockImplementation(async function (this: any) {
      state.client = this;
      return 'fixture';
    });
    const adapter = createDiscordAdapter({
      applicationId: 'fixture',
      botToken: 'fixture',
      publicKey: 'fixture',
    }) as any;
    adapter.forwardGatewayEvent = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          forwarded = resolve;
        }),
    );
    const abort = new AbortController();
    let stopped = false;
    const listener = adapter
      .runGatewayListener(60000, abort.signal, 'http://localhost/webhook')
      .then(() => {
        stopped = true;
      });
    await vi.waitFor(() => expect(state.client.login).toHaveBeenCalled());
    state.client.emit('raw', { t: 'MESSAGE_CREATE', d: { author: { bot: false } } });
    abort.abort();
    await vi.waitFor(() => expect(state.destroy).toHaveBeenCalled());
    expect(stopped).toBe(false);
    destroyed();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(stopped).toBe(false);
    forwarded();
    await listener;
    state.client.sweepers.destroy();
    vi.restoreAllMocks();
    expect(stopped).toBe(true);
  });
});
