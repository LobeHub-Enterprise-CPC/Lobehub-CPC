// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getChannelGatewayUrl, isChannelGatewayReady } from './gateway';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Channel service address', () => {
  it.each([
    '',
    ' ',
    'channel-worker:3211',
    'file:///tmp/worker',
    'http://user:pass@worker',
    'http://worker?key=x',
  ])('fails closed without a valid service URL: %s', async (url) => {
    vi.stubEnv('CHANNEL_GATEWAY_URL', url);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(getChannelGatewayUrl()).toBeUndefined();
    expect(await isChannelGatewayReady()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('contacts the configured address and retains a reverse-proxy prefix', async () => {
    vi.stubEnv('CHANNEL_GATEWAY_URL', ' https://gateway.example/internal/channel ');
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'ready' }));
    vi.stubGlobal('fetch', fetch);
    expect(await isChannelGatewayReady()).toBe(true);
    expect(fetch.mock.calls[0][0].href).toBe('https://gateway.example/internal/channel/healthz');
    expect(fetch.mock.calls[0][1]).toMatchObject({ cache: 'no-store', redirect: 'error' });
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    new Response('down', { status: 503 }),
    Response.json({ status: 'not-ready' }),
    Response.json({ unrelatedService: true }),
    new Response('not json'),
  ])('does not treat any HTTP response as a ready coordinator', async (response) => {
    vi.stubEnv('CHANNEL_GATEWAY_URL', 'http://channel-worker:3211');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    expect(await isChannelGatewayReady()).toBe(false);
  });

  it('fails closed on connection failure', async () => {
    vi.stubEnv('CHANNEL_GATEWAY_URL', 'http://channel-worker:3211');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    expect(await isChannelGatewayReady()).toBe(false);
  });
});
