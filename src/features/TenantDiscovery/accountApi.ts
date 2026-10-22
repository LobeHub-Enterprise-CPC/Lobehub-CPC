/**
 * Client for the remembered-account endpoints (`POST /api/tenant-discovery/account*`).
 *
 * They run on the same platform origin as the finder routes, so `installTenantFetch` leaves
 * them alone and they reach the root `/api/tenant-discovery/*` routes. Requests are same-origin
 * `POST`s with `no-store`, mirroring the finder's `postJson`.
 */

import { type DiscoveredOrganization } from './api';

const ACCOUNT_PATH = '/api/tenant-discovery/account';
const SELECT_PATH = `${ACCOUNT_PATH}/select`;
const FORGET_PATH = `${ACCOUNT_PATH}/forget`;

export interface RememberedAccount {
  email: string;
  lastTenantId: string | null;
  organizations: DiscoveredOrganization[];
}

export type AccountRequestErrorCode =
  /** 204, or 409 ACCOUNT_MEMORY_MISSING: no remembered account, show the finder form instead. */
  | 'empty'
  /** 404 TENANT_NOT_AVAILABLE on select: that organization cannot be entered right now. */
  | 'notAvailable'
  /** 429 RATE_LIMITED. */
  | 'rateLimited'
  /** 503 TENANT_DISCOVERY_UNAVAILABLE, network failures and anything unexpected: retryable. */
  | 'unavailable';

export class AccountRequestError extends Error {
  constructor(
    readonly code: AccountRequestErrorCode,
    /** Seconds from the `Retry-After` header of a rate-limited response. */
    readonly retryAfter?: number,
  ) {
    super(code);
    this.name = 'AccountRequestError';
  }
}

const parseRetryAfter = (header: string | null): number | undefined => {
  if (!header || !/^\d+$/.test(header.trim())) return undefined;
  const seconds = Number.parseInt(header, 10);
  return seconds > 0 ? seconds : undefined;
};

interface AccountResponse {
  retryAfter?: number;
  status: number;
}

const postAccount = async (
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ data: unknown; response: AccountResponse }> => {
  let response: Response;
  try {
    response = await fetch(path, {
      body: JSON.stringify(body),
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal,
    });
  } catch (error) {
    // A caller that aborted does not want an error shown for it.
    if (signal?.aborted) throw error;
    throw new AccountRequestError('unavailable');
  }
  const retryAfter =
    response.status === 429 ? parseRetryAfter(response.headers.get('Retry-After')) : undefined;
  if (response.status === 204) return { data: null, response: { retryAfter, status: 204 } };
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    if (!response.ok) throw new AccountRequestError('unavailable', retryAfter);
  }
  return { data, response: { retryAfter, status: response.status } };
};

const isOrganization = (value: unknown): value is DiscoveredOrganization => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    (item.address === undefined || typeof item.address === 'string')
  );
};

const toOrganizations = (value: unknown): DiscoveredOrganization[] | null => {
  if (!Array.isArray(value) || !value.every((item) => isOrganization(item))) return null;
  return value.map(({ address, id, name }) => ({ ...(address ? { address } : {}), id, name }));
};

/** The remembered account and its organizations; throws `empty` when there is none. */
export const fetchRememberedAccount = async (signal?: AbortSignal): Promise<RememberedAccount> => {
  const { data, response } = await postAccount(ACCOUNT_PATH, {}, signal);
  if (response.status === 204) throw new AccountRequestError('empty');
  if (response.status === 409) {
    if ((await readCode(data)) === 'ACCOUNT_MEMORY_MISSING') throw new AccountRequestError('empty');
    throw new AccountRequestError('unavailable');
  }
  if (response.status === 429) throw new AccountRequestError('rateLimited', response.retryAfter);
  if (response.status !== 200) throw new AccountRequestError('unavailable');
  const account = data as { email?: unknown; lastTenantId?: unknown; organizations?: unknown };
  const organizations = toOrganizations(account?.organizations);
  if (typeof account?.email !== 'string' || !organizations)
    throw new AccountRequestError('unavailable');
  const lastTenantId =
    typeof account.lastTenantId === 'string' &&
    organizations.some((organization) => organization.id === account.lastTenantId)
      ? account.lastTenantId
      : null;
  return { email: account.email, lastTenantId, organizations };
};

const readCode = async (data: unknown): Promise<string | undefined> =>
  data && typeof data === 'object' && typeof (data as { code?: unknown }).code === 'string'
    ? ((data as { code?: string }).code as string)
    : undefined;

/**
 * The entry URL of the chosen organization, through the remembered account.
 * Throws `empty` when the remembered account is gone (fall back to the finder form),
 * `notAvailable` when that organization cannot be entered right now.
 */
export const selectRememberedOrganization = async (
  id: string,
  signal?: AbortSignal,
): Promise<string> => {
  const { data, response } = await postAccount(SELECT_PATH, { id }, signal);
  if (response.status === 200) {
    const url = (data as { url?: unknown } | null)?.url;
    if (typeof url !== 'string') throw new AccountRequestError('unavailable');
    try {
      // Only ever navigate to a web address, whatever the response carried.
      const parsed = new URL(url, window.location.href);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        throw new Error('unsupported');
      return url;
    } catch {
      throw new AccountRequestError('unavailable');
    }
  }
  if (response.status === 409 && (await readCode(data)) === 'ACCOUNT_MEMORY_MISSING')
    throw new AccountRequestError('empty');
  if (response.status === 404 && (await readCode(data)) === 'TENANT_NOT_AVAILABLE')
    throw new AccountRequestError('notAvailable');
  if (response.status === 429) throw new AccountRequestError('rateLimited', response.retryAfter);
  throw new AccountRequestError('unavailable');
};

/**
 * Forget the remembered account. Never throws: the caller navigates to `/?switch=1`
 * whether the request succeeded or not.
 */
export const forgetRememberedAccount = async (signal?: AbortSignal): Promise<void> => {
  try {
    await postAccount(FORGET_PATH, {}, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
  }
};
