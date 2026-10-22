import { netFetch } from '@/utils/net-fetch';

/** Control-plane requests (discovery, handoff, token, jwks) must not hang the flow. */
export const CONTROL_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Fetch for requests that carry credentials, handoff state or key material: a 3xx is
 * never followed, so a compromised or misconfigured server cannot bounce a request
 * (and its headers or body) to another origin.
 */
export const fetchNoRedirect = (url: string, init: RequestInit = {}): Promise<Response> =>
  netFetch(url, {
    signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
    ...init,
    redirect: 'error',
  });

/** Read a response body as text, refusing anything over `maxBytes`. */
export const readTextLimited = async (response: Response, maxBytes: number): Promise<string> => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Response body too large');
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('Response body too large');
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
};

export const readJsonLimited = async <T = unknown>(
  response: Response,
  maxBytes: number,
): Promise<T> => JSON.parse(await readTextLimited(response, maxBytes)) as T;
