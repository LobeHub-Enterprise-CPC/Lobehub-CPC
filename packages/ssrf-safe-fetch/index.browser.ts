/**
 * Browser version of SSRF-safe fetch
 * In browser environments, we simply use the native fetch API
 * as SSRF attacks are not applicable in client-side code
 */

export * from './redact';

/**
 * Options for per-call SSRF configuration overrides
 * (ignored in browser - kept for API parity with server version)
 */
export interface SSRFOptions {
  /** List of IP addresses to allow */
  allowIPAddressList?: string[];
  /** Whether to allow private/local IP addresses */
  allowPrivateIPAddress?: boolean;
  /** Maximum response body size in bytes (server-only; ignored in browser) */
  maxContentLength?: number;
  /** Stream the response body (server-only; ignored in browser) */
  streamResponse?: boolean;
}

/**
 * Browser-safe fetch implementation
 * Uses native fetch API in browser environments
 * @param url - The URL to fetch
 * @param options - Standard fetch options
 * @param _ssrfOptions - Ignored in browser (kept for API parity)
 */
export const ssrfSafeFetch = async (
  url: string,

  options?: RequestInit,

  _ssrfOptions?: SSRFOptions,
): Promise<Response> => {
  return fetch(url, options);
};

/**
 * Browser version of createSsrfSafeFetch: native fetch, kept for API parity.
 */
export const createSsrfSafeFetch =
  (_ssrfOptions?: SSRFOptions) =>
  (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    fetch(input, init);
