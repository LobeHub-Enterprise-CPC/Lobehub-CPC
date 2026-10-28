import { Readable } from 'node:stream';

import fetch from 'node-fetch';
import type { RequestFilteringAgentOptions } from 'request-filtering-agent';
import { RequestFilteringHttpAgent, RequestFilteringHttpsAgent } from 'request-filtering-agent';

import { redactUrlsInText, sanitizeErrorForLogging } from './redact';

export * from './redact';

/**
 * Options for per-call SSRF configuration overrides
 */
export interface SSRFOptions {
  /** List of IP addresses to allow */
  allowIPAddressList?: string[];
  /** Whether to allow private/local IP addresses */
  allowPrivateIPAddress?: boolean;
  /**
   * Maximum response body size in bytes. When set, the body is consumed
   * incrementally and reading stops as soon as the cap is reached. The returned
   * Response contains only the bytes received up to that point (soft truncation —
   * still considered a successful response).
   *
   * Use this for any fetch that downloads untrusted content (e.g. web crawlers)
   * to prevent unbounded buffering of large or malicious responses from blowing
   * up serverless function memory.
   */
  maxContentLength?: number;
  /**
   * Hand the upstream body to the caller as a stream instead of buffering it.
   * Required for SSE / long-lived responses (model SDKs, MCP transports); the
   * connect-time IP check and redirect-hop check are unchanged.
   */
  streamResponse?: boolean;
}

/** Statuses whose Response must not carry a body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Consume a node-fetch Response body up to `cap` bytes, then stop. Breaking out
 * of `for await` closes the async iterator, which destroys the underlying stream
 * and releases the HTTP connection.
 */
const readBodyWithCap = async (
  body: NodeJS.ReadableStream | null,
  cap: number,
): Promise<Uint8Array> => {
  if (!body) return new Uint8Array(0);

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = cap - total;
    if (buf.length >= remaining) {
      chunks.push(buf.subarray(0, remaining));
      total = cap;
      break;
    }
    chunks.push(buf);
    total += buf.length;
  }

  return Buffer.concat(chunks, total);
};

/**
 * Connect-time filtering agents (request-filtering-agent) configured from the
 * per-call options and the deployment-level SSRF_* environment variables. Use
 * them for clients that take an `agent` instead of a `fetch` (e.g. `ws`).
 */
export const createSsrfSafeAgents = (ssrfOptions?: SSRFOptions) => {
  // Configure SSRF protection options with proper precedence using nullish coalescing
  const envAllowPrivate = process.env.SSRF_ALLOW_PRIVATE_IP_ADDRESS === '1';
  const allowPrivate = ssrfOptions?.allowPrivateIPAddress ?? envAllowPrivate;

  const agentOptions: RequestFilteringAgentOptions = {
    allowIPAddressList:
      ssrfOptions?.allowIPAddressList ??
      process.env.SSRF_ALLOW_IP_ADDRESS_LIST?.split(',')
        .map((ip) => ip.trim())
        .filter(Boolean) ??
      [],
    allowMetaIPAddress: allowPrivate,
    allowPrivateIPAddress: allowPrivate,
    denyIPAddressList: [],
  };

  return {
    httpAgent: new RequestFilteringHttpAgent(agentOptions),
    httpsAgent: new RequestFilteringHttpsAgent(agentOptions),
  };
};

/**
 * SSRF-safe fetch implementation for server-side use
 * Uses request-filtering-agent to prevent requests to private IP addresses
 *
 * @param url - The URL to fetch
 * @param options - Standard fetch options
 * @param ssrfOptions - Optional per-call SSRF configuration overrides
 * @see https://lobehub.com/docs/self-hosting/environment-variables/basic#ssrf-allow-private-ip-address
 */
export const ssrfSafeFetch = async (
  url: string,

  options?: RequestInit,
  ssrfOptions?: SSRFOptions,
): Promise<Response> => {
  try {
    // Create agents for both protocols
    const { httpAgent, httpsAgent } = createSsrfSafeAgents(ssrfOptions);

    // Use node-fetch with SSRF protection agent
    // Pass a function to dynamically select agent based on URL protocol
    // This handles redirects from HTTP to HTTPS correctly
    const response = await fetch(url, {
      ...options,
      agent: (parsedURL: URL) => (parsedURL.protocol === 'https:' ? httpsAgent : httpAgent),
    } as any);

    const cap = ssrfOptions?.maxContentLength;
    let body: BodyInit | null;
    if (NULL_BODY_STATUSES.has(response.status)) {
      body = null;
    } else if (ssrfOptions?.streamResponse && response.body) {
      body = Readable.toWeb(response.body as unknown as Readable) as unknown as ReadableStream;
    } else if (cap && cap > 0) {
      // Buffer is a Uint8Array subclass; the Response constructor accepts it at
      // runtime even though the BodyInit lib type doesn't list Uint8Array.
      body = (await readBodyWithCap(response.body as NodeJS.ReadableStream | null, cap)) as any;
    } else {
      body = await response.arrayBuffer();
    }

    // Convert node-fetch Response to standard Response
    return new Response(body, {
      headers: response.headers as any,
      status: response.status,
      statusText: response.statusText,
    });
  } catch (error) {
    // The failed request's URL (userinfo, query-string API keys) is echoed in the
    // error message and cause chain, and both end up in logs and API responses.
    // Only ever log / rethrow a sanitized copy.
    const safeError = sanitizeErrorForLogging(error);
    const errorMessage = redactUrlsInText(error instanceof Error ? error.message : String(error));
    // request-filtering-agent errors contain "is not allowed" when blocking private/denied IPs
    const isSSRFBlock = errorMessage.includes('is not allowed');

    if (isSSRFBlock) {
      console.error('SSRF protection blocked request:', safeError);
      throw new Error(
        `SSRF blocked: ${errorMessage}. ` +
          'See: https://lobehub.com/docs/self-hosting/environment-variables/basic#ssrf-allow-private-ip-address',
        // eslint-disable-next-line preserve-caught-error -- the cause is the sanitized copy on purpose
        { cause: safeError },
      );
    }

    console.error('Fetch error:', safeError);
    // eslint-disable-next-line preserve-caught-error -- the cause is the sanitized copy on purpose
    throw new Error(`Fetch failed: ${errorMessage}`, { cause: safeError });
  }
};

/**
 * Build a `fetch`-compatible function for SDKs that accept a custom `fetch`
 * (OpenAI, Anthropic, Google GenAI, Ollama, MCP transports, ...). Every
 * connection, including redirect hops, is IP-checked by request-filtering-agent
 * at connect time, so DNS rebinding cannot swap in a private address after a
 * pre-check. Responses are streamed.
 */
export const createSsrfSafeFetch =
  (ssrfOptions?: SSRFOptions) =>
  async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' || input instanceof URL) {
      return ssrfSafeFetch(String(input), init, { ...ssrfOptions, streamResponse: true });
    }

    // Request object: carry its method / headers / body over, init wins.
    const hasBody = input.method !== 'GET' && input.method !== 'HEAD';
    return ssrfSafeFetch(
      input.url,
      {
        body: hasBody ? await input.clone().arrayBuffer() : undefined,
        headers: input.headers,
        method: input.method,
        signal: input.signal,
        ...init,
      } as RequestInit,
      { ...ssrfOptions, streamResponse: true },
    );
  };
