import { request } from 'node:http';

import { appEnv } from '@/envs/app';

import { resolveDeliveryTarget } from './address';
import { HATCHET_TIMING } from './config';
import { compileRetryDelay, defaultRetryDelayMs, parseRetryAfter } from './retryDelay';
import { signUpstashRequest } from './signature';
import type { DeliveryAttempt, DeliveryInput, DeliveryOutcome } from './types';

interface DeliveryDependencies {
  env?: Parameters<typeof resolveDeliveryTarget>[1];
  now?: () => number;
  signingKey?: string;
}

interface DeliveryResponse {
  headers: Headers;
  status: number;
}

const RESPONSE_LIMIT = 64 * 1024;
const reservedHeaders = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upstash-signature',
  'upstash-message-id',
  'upstash-retried',
]);

const deliveryHeaders = (
  input: DeliveryInput,
  attempt: DeliveryAttempt,
  signingKey: string,
  now: number,
): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input.headers)) {
    const forwarded = name.replace(/^Upstash-Forward-/i, '');
    if (!reservedHeaders.has(forwarded.toLowerCase())) headers.set(forwarded, value);
  }
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  headers.set(
    'Upstash-Signature',
    signUpstashRequest({
      body: input.body,
      messageId: attempt.messageId,
      now,
      signingKey,
      url: input.url,
    }),
  );
  headers.set('Upstash-Message-Id', attempt.messageId);
  headers.set('Upstash-Retried', String(attempt.attempt));
  return headers;
};

const loopbackRequest = (
  url: URL,
  headers: Headers,
  body: string,
  signal: AbortSignal,
): Promise<DeliveryResponse> =>
  new Promise((resolve, reject) => {
    // The self listener binds one resolved address. Racing address families
    // can discard its connected socket while a busy event loop delays readiness.
    const options = {
      autoSelectFamily: false,
      headers: Object.fromEntries(headers),
      method: 'POST',
      signal,
    };
    const req = request(url, options, (res) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined)
          responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const response = { headers: responseHeaders, status: res.statusCode ?? 0 };
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes >= RESPONSE_LIMIT) {
          // Resolve before closing the socket so truncation cannot become a transport failure.
          resolve(response);
          res.destroy();
        }
      });
      res.on('end', () => resolve(response));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });

const externalRequest = async (
  url: URL,
  headers: Headers,
  body: string,
  signal: AbortSignal,
): Promise<DeliveryResponse> => {
  const res = await fetch(url, { body, headers, method: 'POST', redirect: 'error', signal });
  const reader = res.body?.getReader();
  if (reader) {
    try {
      let bytes = 0;
      while (bytes < RESPONSE_LIMIT) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
      if (bytes >= RESPONSE_LIMIT) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  return { headers: res.headers, status: res.status };
};

const errorReason = (error: unknown): string => {
  if (!(error instanceof Error)) return 'Error';
  const code = 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : error.name;
};

export const deliver = async (
  input: DeliveryInput,
  attempt: DeliveryAttempt,
  deps: DeliveryDependencies = {},
): Promise<DeliveryOutcome> => {
  const signingKey = deps.signingKey ?? process.env.QSTASH_CURRENT_SIGNING_KEY;
  if (!signingKey) return { kind: 'failed', reason: 'signing key missing' };
  const now = deps.now ?? Date.now;

  let target: ReturnType<typeof resolveDeliveryTarget>;
  let headers: Headers;
  let retryDelay: ReturnType<typeof compileRetryDelay> | undefined;
  try {
    retryDelay = input.retryDelay === undefined ? undefined : compileRetryDelay(input.retryDelay);
    target = resolveDeliveryTarget(
      input.url,
      deps.env ?? {
        agentRuntimeBaseUrl: process.env.AGENT_RUNTIME_BASE_URL,
        appUrl: appEnv.APP_URL,
        hostname: process.env.HOSTNAME,
        internalAppUrl: appEnv.INTERNAL_APP_URL || appEnv.APP_URL,
        port: process.env.PORT ?? '3210',
      },
    );
    headers = deliveryHeaders(input, attempt, signingKey, now());
    if (target.loopback) headers.set('Host', target.host);
  } catch {
    return { kind: 'failed', reason: 'InvalidInput' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  let response: DeliveryResponse | undefined;
  let reason: string;
  try {
    response = target.loopback
      ? await loopbackRequest(target.url, headers, input.body, controller.signal)
      : await externalRequest(target.url, headers, input.body, controller.signal);
    reason = 'HTTP ' + response.status;
  } catch (error) {
    reason = controller.signal.aborted ? 'TimeoutError' : errorReason(error);
  } finally {
    clearTimeout(timer);
  }

  const status = response ? { status: response.status } : {};
  if (response && response.status >= 200 && response.status < 300)
    return { kind: 'delivered', status: response.status };
  if (
    response?.headers.get('Upstash-NonRetryable-Error')?.toLowerCase() === 'true' ||
    attempt.attempt >= input.retries
  )
    return { kind: 'failed', reason, ...status };

  const retryAfter = response?.headers.get('Retry-After');
  const parsedRetryAfter =
    retryAfter === null || retryAfter === undefined
      ? undefined
      : parseRetryAfter(retryAfter, now());
  try {
    const afterMs =
      parsedRetryAfter !== undefined && parsedRetryAfter <= HATCHET_TIMING.retryWaitCapMs
        ? parsedRetryAfter
        : retryDelay
          ? retryDelay(attempt.attempt)
          : defaultRetryDelayMs(attempt.attempt + 1);
    return {
      kind: 'retry',
      reason,
      ...status,
      afterMs: Math.min(afterMs, HATCHET_TIMING.retryWaitCapMs),
    };
  } catch {
    return { kind: 'failed', reason: 'InvalidRetryDelay', ...status };
  }
};
