import { buildRemoteUrl } from '@lobechat/utils/remoteUrl';

import { appendVercelCookie } from '@/utils/http-headers';
import { setDesktopUserAgentHeader } from '@/utils/user-agent';

import { buildExpectedIssuer, normalizeEntryUrl } from './entry';
import { fetchNoRedirect, readJsonLimited } from './safeFetch';

const MAX_SMALL_JSON_BYTES = 16 * 1024;

const jsonHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  appendVercelCookie(headers);
  setDesktopUserAgentHeader(headers);
  return headers;
};

const drain = async (response: Response) => {
  await response.body?.cancel().catch(() => undefined);
};

/** The `code` of a small JSON error body, or undefined when there is none. */
const readErrorCode = async (response: Response): Promise<string | undefined> => {
  try {
    const body = await readJsonLimited<{ code?: unknown }>(response, MAX_SMALL_JSON_BYTES);
    return typeof body?.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
};

/** Seconds or HTTP-date, capped; falls back when absent or unusable. */
export const parseRetryAfterMs = (value: string | null, fallbackMs: number, maxMs = 60_000) => {
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, maxMs);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), maxMs);
  return fallbackMs;
};

export const isEndpointChangedResponse = async (response: Response): Promise<boolean> => {
  if (response.status !== 409) return false;
  try {
    const body = await readJsonLimited<{ code?: unknown }>(response, MAX_SMALL_JSON_BYTES);
    return body?.code === 'TENANT_ENDPOINT_CHANGED';
  } catch {
    return false;
  }
};

/** Entry the platform selected for this authorization (first successful read only). */
export interface PlatformSnapshot {
  endpointVersion: number;
  entry: string;
  name: string;
  tenantId: string;
}

export type PlatformHandoffResult =
  | { snapshot: PlatformSnapshot; status: 'ready' }
  | { retryAfterMs: number; status: 'rate_limited' }
  | { status: 'invalid' | 'misconfigured' | 'pending' | 'rejected' | 'transient' };

// Field bounds mirror the server's snapshot schema
// (apps/server/src/services/tenantDiscovery/desktop.ts), so anything it would never issue is
// rejected here instead of being bound.
const MAX_SNAPSHOT_ENTRY_LENGTH = 2048;
const MAX_SNAPSHOT_NAME_LENGTH = 4096;
const MAX_SNAPSHOT_TENANT_ID_LENGTH = 128;
const SNAPSHOT_TENANT_ID_PATTERN = /^[\w.:-]+$/;

const parseSnapshot = (body: unknown, allowLoopbackHttp: boolean): PlatformSnapshot | null => {
  if (typeof body !== 'object' || body === null) return null;
  const { endpointVersion, entry, name, tenantId } = body as Record<string, unknown>;

  if (
    typeof tenantId !== 'string' ||
    tenantId.length === 0 ||
    tenantId.length > MAX_SNAPSHOT_TENANT_ID_LENGTH ||
    !SNAPSHOT_TENANT_ID_PATTERN.test(tenantId)
  ) {
    return null;
  }
  if (typeof entry !== 'string' || entry.length > MAX_SNAPSHOT_ENTRY_LENGTH) return null;
  const normalizedEntry = normalizeEntryUrl(entry, allowLoopbackHttp);
  if (!normalizedEntry) return null;
  if (!Number.isInteger(endpointVersion) || (endpointVersion as number) <= 0) return null;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_SNAPSHOT_NAME_LENGTH) {
    return null;
  }

  return { endpointVersion: endpointVersion as number, entry: normalizedEntry, name, tenantId };
};

/**
 * One poll of the platform's non-destructive desktop handoff
 * (`POST <origin>/api/tenant-discovery/desktop-handoff`). The state and challenge only
 * travel in the request body, and the response is never followed to another URL.
 */
export const requestDesktopHandoff = async (
  platformOrigin: string,
  params: { codeChallenge: string; state: string },
  allowLoopbackHttp: boolean,
): Promise<PlatformHandoffResult> => {
  let response: Response;
  try {
    response = await fetchNoRedirect(
      buildRemoteUrl('/api/tenant-discovery/desktop-handoff', platformOrigin).toString(),
      {
        body: JSON.stringify({ codeChallenge: params.codeChallenge, state: params.state }),
        headers: jsonHeaders(),
        method: 'POST',
      },
    );
  } catch {
    return { status: 'transient' };
  }

  if (response.status === 404) {
    // Only the server's own `{code:'HANDOFF_NOT_FOUND'}` (not chosen yet, expired, challenge
    // mismatch, unusable snapshot — indistinguishable by design) means keep waiting. Any other
    // 404 (NOT_FOUND, no code, a non-JSON page from a proxy or the wrong host) means this
    // address does not serve the desktop handoff, which waiting cannot fix. The tenant
    // `/oidc/handoff` below is different: there a plain 404 is the normal "not ready" answer.
    return (await readErrorCode(response)) === 'HANDOFF_NOT_FOUND'
      ? { status: 'pending' }
      : { status: 'misconfigured' };
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), 10_000);
    await drain(response);
    return { retryAfterMs, status: 'rate_limited' };
  }
  if (response.status === 400) {
    await drain(response);
    return { status: 'rejected' };
  }
  if (response.status >= 500) {
    await drain(response);
    return { status: 'transient' };
  }
  if (response.status !== 200) {
    await drain(response);
    return { status: 'invalid' };
  }

  try {
    const snapshot = parseSnapshot(
      await readJsonLimited(response, MAX_SMALL_JSON_BYTES),
      allowLoopbackHttp,
    );
    return snapshot ? { snapshot, status: 'ready' } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
};

export type TenantHandoffResult =
  | { code: string; state: string; status: 'ready' }
  | { retryAfterMs: number; status: 'rate_limited' }
  | {
      status:
        'endpoint_changed' | 'invalid_entry' | 'pending' | 'rejected' | 'transient' | 'unexpected';
    };

/** One poll of `<entry>/oidc/handoff` for the authorization code of this state. */
export const pollTenantHandoff = async (
  entry: string,
  state: string,
): Promise<TenantHandoffResult> => {
  const url = buildRemoteUrl('/oidc/handoff', entry);
  url.searchParams.set('id', state);
  url.searchParams.set('client', 'desktop');

  let response: Response;
  try {
    response = await fetchNoRedirect(url.toString(), { headers: jsonHeaders(), method: 'GET' });
  } catch {
    return { status: 'transient' };
  }

  if (response.status === 404) {
    // Only the plain "record not found or expired" body (no `code`) means keep waiting; a
    // coded 404 (e.g. NOT_FOUND for an unregistered host) is an addressing failure.
    return (await readErrorCode(response)) === undefined
      ? { status: 'pending' }
      : { status: 'invalid_entry' };
  }
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), 10_000);
    await drain(response);
    return { retryAfterMs, status: 'rate_limited' };
  }
  if (response.status === 409) {
    return (await isEndpointChangedResponse(response))
      ? { status: 'endpoint_changed' }
      : { status: 'unexpected' };
  }
  if (response.status === 400) {
    const code = await readErrorCode(response);
    return code === 'TENANT_REQUIRED' || code === 'TENANT_INVALID'
      ? { status: 'invalid_entry' }
      : { status: 'rejected' };
  }
  if (response.status >= 500) {
    await drain(response);
    return { status: 'transient' };
  }
  if (!response.ok) {
    await drain(response);
    return { status: 'unexpected' };
  }

  try {
    const data = await readJsonLimited<{
      data?: { payload?: { code?: unknown; state?: unknown } };
      success?: boolean;
    }>(response, MAX_SMALL_JSON_BYTES);
    const payload = data?.data?.payload;
    if (
      data?.success &&
      payload &&
      typeof payload.code === 'string' &&
      typeof payload.state === 'string'
    ) {
      return { code: payload.code, state: payload.state, status: 'ready' };
    }
    return { status: 'pending' };
  } catch {
    return { status: 'unexpected' };
  }
};

export type PreflightResult = 'endpoint_changed' | 'invalid' | 'ok';

/**
 * Known-entry preflight: `<entry>/oidc/.well-known/openid-configuration` must answer 200
 * with exactly the issuer this entry will be bound to. Anything else fails closed.
 */
export const preflightEntry = async (entry: string): Promise<PreflightResult> => {
  let response: Response;
  try {
    response = await fetchNoRedirect(
      buildRemoteUrl('/oidc/.well-known/openid-configuration', entry).toString(),
      { headers: { Accept: 'application/json' }, method: 'GET' },
    );
  } catch {
    return 'invalid';
  }

  if (response.status === 409) {
    return (await isEndpointChangedResponse(response)) ? 'endpoint_changed' : 'invalid';
  }
  if (response.status !== 200) {
    await drain(response);
    return 'invalid';
  }

  try {
    const metadata = await readJsonLimited<{ issuer?: unknown }>(response, MAX_SMALL_JSON_BYTES);
    return metadata?.issuer === buildExpectedIssuer(entry) ? 'ok' : 'invalid';
  } catch {
    return 'invalid';
  }
};
