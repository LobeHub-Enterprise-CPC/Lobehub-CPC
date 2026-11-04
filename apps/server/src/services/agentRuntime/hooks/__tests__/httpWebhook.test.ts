import { inspect } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverWebhook, executeToolCallWebhook, resolveWebhookHeaders } from '../httpWebhook';

const { fetchMock, publish } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  publish: vi.fn(),
}));
vi.mock('@/server/modules/Hatchet/directDelivery', () => ({
  getDirectDeliveryClient: () => ({ publishJSON: publish }),
}));
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const config = { responseHandling: 'toolCall' as const, url: 'https://example.com/hooks' };

describe('HTTP hook primitive', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    publish.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('uses fetch without redirects and with a default deadline', async () => {
    fetchMock.mockResolvedValue(new Response('{"decision":"allow"}'));
    expect(await executeToolCallWebhook(config, { args: { value: 1 } })).toMatchObject({
      status: 'success',
    });
    const [, request] = fetchMock.mock.calls[0];
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      body: '{"args":{"value":1}}',
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([200, 204, 205])('ignores empty decision response %i', async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    expect(await executeToolCallWebhook(config, {})).toEqual({
      status: 'ignored',
    });
  });
  it.each([201, 202, 206])(
    'accepts a valid decision on a successful HTTP response: %i',
    async (status) => {
      fetchMock.mockResolvedValue(new Response('{"decision":"allow"}', { status }));
      expect(await executeToolCallWebhook(config, {})).toEqual({
        status: 'success',
        decision: { decision: 'allow' },
      });
    },
  );
  it.each(['{', 'notification accepted', '{}', 'null', '[]'])(
    'ignores a successful response without a decision: %s',
    async (body) => {
      fetchMock.mockResolvedValue(new Response(body));
      expect(await executeToolCallWebhook(config, {})).toEqual({ status: 'ignored' });
    },
  );
  it.each([200, 204, 205])('accepts empty notification response %i', async (status) => {
    fetchMock.mockResolvedValue(new Response(null, { status }));
    await expect(deliverWebhook({ url: config.url }, {})).resolves.toBeUndefined();
  });
  it.each([301, 400, 500])('rejects status %i without parsing the body', async (status) => {
    fetchMock.mockResolvedValue(new Response('{"decision":"allow"}', { status }));
    expect(await executeToolCallWebhook(config, {})).toEqual({
      status: 'error',
      code: 'http_error',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('returns sanitized errors and never retries', async () => {
    fetchMock.mockRejectedValue(new Error('secret remote response'));
    expect(await executeToolCallWebhook(config, {})).toEqual({
      status: 'error',
      code: 'network_error',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects oversize before parsing, including whitespace', async () => {
    fetchMock.mockResolvedValue(new Response('{}' + ' '.repeat(65_535)));
    expect(await executeToolCallWebhook(config, {})).toEqual({
      status: 'error',
      code: 'response_too_large',
    });
  });
  it('times out while waiting and distinguishes cancellation', async () => {
    fetchMock.mockImplementation(
      (_url, { signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
    );
    expect(await executeToolCallWebhook({ ...config, timeout: 0.01 }, {})).toEqual({
      status: 'error',
      code: 'timeout',
    });
    const controller = new AbortController();
    const pending = executeToolCallWebhook(config, {}, { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(await executeToolCallWebhook(config, {}, { signal: controller.signal })).toEqual({
      status: 'cancelled',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('discards a late allow after cancellation even if transport ignores abort', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      return new Response('{"decision":"allow"}');
    });
    expect(await executeToolCallWebhook(config, {}, { signal: controller.signal })).toEqual({
      status: 'cancelled',
    });
  });
  it('refuses controls in the notification path and invalid control config before sending', async () => {
    await expect(deliverWebhook(config, {})).rejects.toThrow('configuration');
    expect(await executeToolCallWebhook({ ...config, eventFields: [] }, {})).toEqual({
      status: 'error',
      code: 'configuration',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('ignores legacy notification response bodies', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json'));
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0xff])));
    fetchMock.mockResolvedValueOnce(new Response('{"decision":"deny","reason":"ignored"}'));
    await expect(
      deliverWebhook({ url: config.url, fallback: 'none' }, {}),
    ).resolves.toBeUndefined();
    await expect(deliverWebhook({ url: config.url }, {})).resolves.toBeUndefined();
    await expect(deliverWebhook({ url: config.url }, {})).resolves.toBeUndefined();
  });
  it('expands only allowed env values at send time without mutating configuration', async () => {
    vi.stubEnv('HOOK_TOKEN', 'first-secret');
    const webhook = {
      ...config,
      allowedEnvVars: ['HOOK_TOKEN'],
      headers: { 'Authorization': 'Bearer ${HOOK_TOKEN}', 'X-Static': 'value' },
    };
    expect(resolveWebhookHeaders(webhook).authorization).toBe('Bearer first-secret');
    vi.stubEnv('HOOK_TOKEN', 'rotated-secret');
    expect(resolveWebhookHeaders(webhook).authorization).toBe('Bearer rotated-secret');
    expect(webhook.headers.Authorization).toBe('Bearer ${HOOK_TOKEN}');
    expect(() => resolveWebhookHeaders({ ...webhook, allowedEnvVars: [] })).toThrow(
      'configuration',
    );
    vi.stubEnv('HOOK_TOKEN', undefined);
    expect(() => resolveWebhookHeaders(webhook)).toThrow('configuration');
  });
  it.each<Record<string, string>>([
    { Host: 'internal' },
    { 'Content-Length': '1' },
    { 'Upstash-Callback': 'evil' },
    { 'X-Key': '${NOPE}' },
    { 'X-Key': 'bad\r\nsecret' },
    { 'X-Key': '${broken' },
  ])('rejects unsafe headers %#', (headers) => {
    expect(() => resolveWebhookHeaders({ ...config, headers })).toThrow('configuration');
  });
  it('forwards templates and timeout to the queued delivery; fallback:none never sends unsigned fetch', async () => {
    vi.stubEnv('HOOK_TOKEN', 'secret');
    const webhook = {
      url: config.url,
      delivery: 'qstash' as const,
      timeout: 4,
      fallback: 'none' as const,
      headers: { Authorization: 'Bearer ${HOOK_TOKEN}' },
      allowedEnvVars: ['HOOK_TOKEN'],
    };
    await deliverWebhook(webhook, { value: 1 });
    expect(publish.mock.calls[0][0]).toMatchObject({
      body: { value: 1 },
      headers: { authorization: 'Bearer secret' },
      timeout: 4,
      url: config.url,
    });
    publish.mockRejectedValue(new Error('private-response private-header'));
    const error = await deliverWebhook(webhook, {}).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'network_error' });
    expect(inspect(error)).not.toMatch(/private-response|private-header/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('falls back to fetch once when publishing fails, logging the failure', async () => {
    publish.mockRejectedValue(new Error('private-response'));
    fetchMock.mockRejectedValue(new Error('offline'));
    const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(deliverWebhook({ url: config.url, delivery: 'qstash' }, {})).rejects.toThrow(
      'network_error',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger).toHaveBeenCalledWith(
      '[HookDispatcher] Queued delivery failed, falling back to fetch',
      expect.objectContaining({ code: 'network_error' }),
    );
    expect(inspect(logger.mock.calls)).not.toContain('private-response');
  });
  it('passes one stable deduplication key per hook event, and none when not asked', async () => {
    publish.mockResolvedValue({ messageId: 'run_1' });
    const dedup = 'op-1:hook-1:onComplete:done';
    await deliverWebhook({ delivery: 'qstash', url: config.url }, {}, { deduplicationId: dedup });
    await deliverWebhook({ delivery: 'qstash', url: config.url }, {});
    const [[keyed], [plain]] = publish.mock.calls;
    expect(keyed.deduplicationId).toBe(dedup);
    expect(plain).not.toHaveProperty('deduplicationId');
  });
});

describe('credential and response boundaries', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it('adds automatic deployment bypass only for the configured application origin', async () => {
    publish.mockReset().mockResolvedValue({ messageId: 'test' });
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('INTERNAL_APP_URL', undefined);
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'private-bypass');
    await deliverWebhook({ delivery: 'qstash', url: 'https://external.example.com/hook' }, {});
    expect(publish.mock.calls[0][0].headers).not.toHaveProperty('x-vercel-protection-bypass');
    await deliverWebhook({ delivery: 'qstash', url: '/hook' }, {});
    expect(publish.mock.calls[1][0].headers['x-vercel-protection-bypass']).toBe('private-bypass');
  });
  it('reports invalid UTF-8 as a protocol error', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([0xc3, 0x28])));
    expect(await executeToolCallWebhook(config, {})).toEqual({
      code: 'invalid_response',
      status: 'error',
    });
  });
});
