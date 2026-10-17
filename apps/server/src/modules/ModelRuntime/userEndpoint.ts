import { createSsrfSafeFetch } from '@lobechat/ssrf-safe-fetch';

/**
 * Transport for provider endpoints that a user or tenant typed in (provider
 * `baseURL` in key vaults or a client payload).
 *
 * Tenant admins and ordinary users are untrusted relative to the platform, so a
 * user-provided baseURL must not reach loopback, private ranges or cloud
 * metadata. The check happens at connect time (request-filtering-agent, also on
 * every redirect hop), which keeps DNS rebinding from swapping in a private
 * address after validation. Deployments that really host models on a private
 * network opt in with SSRF_ALLOW_PRIVATE_IP_ADDRESS / SSRF_ALLOW_IP_ADDRESS_LIST.
 *
 * Never use this for platform-owned endpoints (env proxy URLs, router channels,
 * built-in defaults): those are administrator configuration and may be private.
 */
export const createUserEndpointFetch = (): typeof fetch =>
  createSsrfSafeFetch() as unknown as typeof fetch;
