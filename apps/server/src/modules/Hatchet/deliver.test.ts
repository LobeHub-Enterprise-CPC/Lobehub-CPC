import { once } from 'node:events';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Socket } from 'node:net';

import { Receiver } from '@upstash/qstash';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { HATCHET_TIMING } from './config';
import { deliver } from './deliver';
import type { DeliveryInput } from './types';

const signingKey = 'delivery-test-key';
let server: Server;
let port: string;
let received: { body: string; headers: IncomingHttpHeaders; url?: string };
let receivedCount = 0;
let status = 200;
let responseHeaders: Record<string, string> = {};
const input: DeliveryInput = {
  body: '{"hello":"世界"}',
  dedupKey: 'dedup-1',
  headers: {},
  retries: 3,
  tenantKey: 'acme',
  timeoutMs: 1000,
  url: 'https://app.example.com/orgs/acme/api/agent/run?step=1',
};
const attempt = { attempt: 0, messageId: 'message-1' };
const deps = () => ({
  env: {
    appUrl: 'https://app.example.com',
    internalAppUrl: 'http://internal.example.com:3210',
    hostname: '127.0.0.1',
    port,
  },
  signingKey,
});

describe('deliver HTTP integration', () => {
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      received = { body, headers: req.headers, url: req.url };
      receivedCount += 1;
      if (req.url?.includes('/hang')) return;
      res.writeHead(status, responseHeaders);
      if (req.url?.includes('/large')) {
        res.end(Buffer.alloc(100_000, 'a'));
      } else if (req.url?.includes('/stall-body')) {
        res.flushHeaders();
        res.write('partial');
      } else {
        res.end('response');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = String((server.address() as AddressInfo).port);
  });
  afterEach(() => {
    status = 200;
    responseHeaders = {};
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  describe('deliver', () => {
    it('delivers exact signed bytes to loopback with trusted transport headers', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const result = await deliver(
        {
          ...input,
          headers: {
            'hOsT': 'evil.example',
            'Content-Length': '1',
            'Connection': 'upgrade',
            'Transfer-Encoding': 'chunked',
            'Upstash-Signature': 'fake',
            'Upstash-Message-Id': 'fake',
            'Upstash-Retried': '99',
            'Upstash-Forward-Authorization': 'Bearer business-token',
            'upstash-forward-host': 'evil.example',
            'Upstash-Forward-Upstash-Signature': 'fake-again',
            'Upstash-Forward-Content-Type': 'text/plain',
          },
        },
        attempt,
        deps(),
      );
      expect(result).toEqual({ kind: 'delivered', status: 200 });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(received.url).toBe('/orgs/acme/api/agent/run?step=1');
      expect(received.body).toBe(input.body);
      expect(received.headers).toMatchObject({
        'host': 'internal.example.com:3210',
        'authorization': 'Bearer business-token',
        'content-type': 'text/plain',
        'upstash-message-id': 'message-1',
        'upstash-retried': '0',
      });
      expect(received.headers['upstash-forward-authorization']).toBeUndefined();
      const receiver = new Receiver({ currentSigningKey: signingKey, nextSigningKey: signingKey });
      await expect(
        receiver.verify({
          body: received.body,
          signature: String(received.headers['upstash-signature']),
          url: input.url,
        }),
      ).resolves.toBe(true);
    });

    it('delivers to a single-family local listener after a busy DNS callback turn', async () => {
      let accepts = 0;
      const local = createServer((_req, res) => {
        accepts += 1;
        res.end('ok');
      });
      local.listen(0, '::1');
      await once(local, 'listening');
      const localPort = String((local.address() as AddressInfo).port);
      const connect = Socket.prototype.connect;
      // Keep real DNS and TCP. Delay only the callback turn: the kernel can
      // connect while JavaScript is busy, before Node processes connect readiness.
      const connectSpy = vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (
        this: Socket,
        ...args: Parameters<Socket['connect']>
      ) {
        this.once('lookup', () => {
          process.nextTick(() => {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
          });
        });
        return connect.apply(this, args);
      });
      try {
        expect(
          await deliver({ ...input, timeoutMs: 5000 }, attempt, {
            ...deps(),
            env: { ...deps().env, hostname: 'localhost', port: localPort },
          }),
        ).toEqual({ kind: 'delivered', status: 200 });
        expect(accepts).toBe(1);
      } finally {
        connectSpy.mockRestore();
        local.closeAllConnections();
        await new Promise<void>((resolve) => local.close(() => resolve()));
      }
    });

    it('uses fetch with redirects disabled for external origins', async () => {
      // localhost is a distinct origin, but resolves to the same test server.
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      expect(
        await deliver({ ...input, url: 'http://localhost:' + port + '/external' }, attempt, deps()),
      ).toEqual({ kind: 'delivered', status: 200 });
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ redirect: 'error' }),
      );
      expect(received.headers.host).toBe('localhost:' + port);
      expect(received.headers['content-type']).toBe('application/json');
    });

    it.each([200, 204, 299])('accepts HTTP %i', async (code) => {
      status = code;
      expect(await deliver(input, attempt, deps())).toEqual({ kind: 'delivered', status: code });
    });

    it('uses one-based default backoff and sends zero-based attempt header', async () => {
      status = 500;
      const result = await deliver(input, { ...attempt, attempt: 1 }, deps());
      expect(result).toMatchObject({ kind: 'retry', status: 500, afterMs: Math.exp(5) * 1000 });
      expect(received.headers['upstash-retried']).toBe('1');
    });

    it.each(['true', 'TrUe'])('honors NonRetryable=%s', async (value) => {
      status = 500;
      responseHeaders = { 'Upstash-NonRetryable-Error': value };
      expect(await deliver(input, attempt, deps())).toMatchObject({ kind: 'failed', status: 500 });
    });

    it('exhausts the per-message retry budget', async () => {
      status = 503;
      expect(await deliver(input, { ...attempt, attempt: 3 }, deps())).toEqual({
        kind: 'failed',
        status: 503,
        reason: 'HTTP 503',
      });
    });

    it.each(['7', '7s', 'Fri, 30 Oct 2026 00:00:07 GMT'])(
      'prioritizes Retry-After %s over expressions',
      async (value) => {
        status = 429;
        responseHeaders = { 'Retry-After': value };
        expect(
          await deliver({ ...input, retryDelay: '100' }, attempt, {
            ...deps(),
            now: () => Date.parse('2026-10-30T00:00:00Z'),
          }),
        ).toMatchObject({ kind: 'retry', status: 429, afterMs: 7000 });
      },
    );

    it.each(['1801', 'invalid', '-1'])('falls back from Retry-After %s', async (value) => {
      status = 500;
      responseHeaders = { 'Retry-After': value };
      expect(
        await deliver(
          { ...input, retryDelay: '10000 * (1 + retried)' },
          { ...attempt, attempt: 2 },
          deps(),
        ),
      ).toMatchObject({ kind: 'retry', afterMs: 30000 });
    });

    it('caps expression and default retry waits', async () => {
      status = 500;
      expect(await deliver({ ...input, retryDelay: '99999999' }, attempt, deps())).toMatchObject({
        kind: 'retry',
        afterMs: HATCHET_TIMING.retryWaitCapMs,
      });
      expect(
        await deliver({ ...input, retries: 10 }, { ...attempt, attempt: 9 }, deps()),
      ).toMatchObject({ kind: 'retry', afterMs: HATCHET_TIMING.retryWaitCapMs });
    });

    it.each(['bad(1)', '-1', '1/0'])('fails safely for retry expression %s', async (retryDelay) => {
      status = 500;
      expect(await deliver({ ...input, retryDelay }, attempt, deps())).toMatchObject({
        kind: 'failed',
      });
    });

    it.each(['/hang', '/stall-body'])('times out the whole loopback response: %s', async (path) => {
      const before = receivedCount;
      expect(
        await deliver({ ...input, timeoutMs: 30, url: deps().env.appUrl + path }, attempt, deps()),
      ).toMatchObject({
        afterMs: Math.exp(2.5) * 1000,
        kind: 'retry',
        reason: 'TimeoutError',
      });
      // Acceptance without a complete response remains ambiguous. Do not replay
      // inline or change the caller's retry policy on this path.
      expect(receivedCount).toBe(before + 1);
      expect(received).toMatchObject({ body: input.body, url: path });
    });

    it('times out external response bodies too', async () => {
      expect(
        await deliver(
          { ...input, timeoutMs: 30, url: 'http://localhost:' + port + '/stall-body' },
          attempt,
          deps(),
        ),
      ).toMatchObject({ kind: 'retry', reason: 'TimeoutError' });
    });

    it('reads at most 64KiB of response without losing status', async () => {
      expect(
        await deliver({ ...input, url: deps().env.appUrl + '/large' }, attempt, deps()),
      ).toEqual({ kind: 'delivered', status: 200 });
      expect(
        await deliver({ ...input, url: 'http://localhost:' + port + '/large' }, attempt, deps()),
      ).toEqual({ kind: 'delivered', status: 200 });
    });

    it('rejects external redirects', async () => {
      status = 302;
      responseHeaders = { Location: 'http://localhost:' + port + '/external' };
      expect(
        await deliver({ ...input, url: 'http://localhost:' + port + '/redirect' }, attempt, deps()),
      ).toMatchObject({ kind: 'retry' });
    });

    it('maps connection refusal and respects exhausted budget', async () => {
      const unused = createServer();
      unused.listen(0, '127.0.0.1');
      await once(unused, 'listening');
      const closedPort = String((unused.address() as AddressInfo).port);
      await new Promise<void>((resolve) => unused.close(() => resolve()));
      const options = { ...deps(), env: { ...deps().env, port: closedPort } };
      expect(await deliver(input, attempt, options)).toMatchObject({
        kind: 'retry',
        reason: 'ECONNREFUSED',
      });
      expect(await deliver({ ...input, retries: 0 }, attempt, options)).toMatchObject({
        kind: 'failed',
        reason: 'ECONNREFUSED',
      });
    });
  });
});

describe('deliver input validation', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('returns a terminal failure for a missing signing key', async () => {
    vi.stubEnv('QSTASH_CURRENT_SIGNING_KEY', '');
    expect(await deliver(input, attempt, { env: deps().env })).toEqual({
      kind: 'failed',
      reason: 'signing key missing',
    });
  });

  it('does not expose body, URL credentials, or header values in errors', async () => {
    const result = await deliver(
      { ...input, url: 'https://secret:password@app.example.com/a' },
      attempt,
      deps(),
    );
    expect(result).toMatchObject({ kind: 'failed' });
    expect(JSON.stringify(result)).not.toMatch(/secret|password|世界/);
  });
});

describe('deliver response mapping', () => {
  const options = {
    env: {
      appUrl: 'https://app.example.com',
      internalAppUrl: 'https://internal.example.com',
      port: '3210',
    },
    now: () => Date.parse('2026-10-30T00:00:00Z'),
    signingKey,
  };
  const externalInput = { ...input, url: 'https://receiver.example.com/callback' };

  afterEach(() => vi.restoreAllMocks());

  it.each([
    [200, {}, undefined, 0, { kind: 'delivered', status: 200 }],
    [500, {}, undefined, 0, { kind: 'retry', afterMs: Math.exp(2.5) * 1000, status: 500 }],
    [429, { 'Retry-After': '7' }, '100', 0, { kind: 'retry', afterMs: 7000, status: 429 }],
    [429, { 'Retry-After': '1801' }, '100', 0, { kind: 'retry', afterMs: 100, status: 429 }],
    [500, {}, 'pow(2, retried) * 1000', 2, { kind: 'retry', afterMs: 4000, status: 500 }],
    [500, {}, 'pow(2, retried) * 1000', 0, { kind: 'retry', afterMs: 1000, status: 500 }],
    [429, { 'Retry-After': '1800' }, '100', 0, { kind: 'retry', afterMs: 1800000 }],
    [
      429,
      { 'Retry-After': '1801' },
      undefined,
      0,
      { kind: 'retry', afterMs: Math.exp(2.5) * 1000 },
    ],
    [500, {}, '99999999', 0, { kind: 'retry', afterMs: HATCHET_TIMING.retryWaitCapMs }],
    [500, { 'Upstash-NonRetryable-Error': 'TrUe' }, undefined, 0, { kind: 'failed', status: 500 }],
    [503, {}, undefined, 3, { kind: 'failed', status: 503 }],
    [500, {}, '-1', 0, { kind: 'failed', reason: 'InvalidRetryDelay' }],
    [500, {}, '1/0', 0, { kind: 'failed', reason: 'InvalidRetryDelay' }],
  ] as const)('maps response case %#', async (code, headers, retryDelay, count, expected) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('response', {
        status: code,
        headers: { ...headers },
      }),
    );
    expect(
      await deliver({ ...externalInput, retryDelay }, { ...attempt, attempt: count }, options),
    ).toMatchObject(expected);
  });

  it('rejects an invalid expression before sending a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(
      await deliver({ ...externalInput, retryDelay: 'unknown(1)' }, attempt, options),
    ).toMatchObject({ kind: 'failed' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('maps network errors without including their sensitive message', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('secret header or body'));
    expect(await deliver(externalInput, attempt, options)).toMatchObject({
      kind: 'retry',
      reason: 'TypeError',
    });
    expect(await deliver({ ...externalInput, retries: 0 }, attempt, options)).toEqual({
      kind: 'failed',
      reason: 'TypeError',
    });
  });

  it('validates signed external headers against actual fetch body', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await deliver(
      {
        ...externalInput,
        headers: Object.fromEntries([
          ['Upstash-Forward-Authorization', 'Bearer token'],
          ...[
            'hOsT',
            'Content-Length',
            'Connection',
            'Transfer-Encoding',
            'Upstash-Signature',
            'Upstash-Message-Id',
            'Upstash-Retried',
          ].flatMap((name) => [
            [name, 'evil'],
            ['Upstash-Forward-' + name, 'evil'],
          ]),
        ]),
      },
      attempt,
      { ...options, now: Date.now },
    );
    const request = fetchSpy.mock.calls[0][1]!;
    const headers = new Headers(request.headers);
    for (const name of ['Host', 'Content-Length', 'Connection', 'Transfer-Encoding'])
      expect(headers.get(name)).toBeNull();
    expect(headers.get('Upstash-Retried')).toBe('0');
    expect([...headers.keys()].some((name) => name.startsWith('upstash-forward-'))).toBe(false);
    expect(headers.get('Authorization')).toBe('Bearer token');
    expect(headers.get('Upstash-Message-Id')).toBe(attempt.messageId);
    const receiver = new Receiver({ currentSigningKey: signingKey, nextSigningKey: signingKey });
    await expect(
      receiver.verify({
        body: String(request.body),
        signature: headers.get('Upstash-Signature')!,
        url: externalInput.url,
      }),
    ).resolves.toBe(true);
  });

  it('cancels large external response streams at the byte limit', async () => {
    const cancel = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          chunks += 1;
          controller.enqueue(new Uint8Array(32 * 1024));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    expect(await deliver(externalInput, attempt, options)).toEqual({
      kind: 'delivered',
      status: 200,
    });
    expect(chunks).toBe(2);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
