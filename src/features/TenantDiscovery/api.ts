/**
 * Client for the root-path organization lookup (`POST /api/tenant-discovery`) and
 * the follow-up `select` call that returns the sign-in URL of the chosen one.
 *
 * Both run from a document that addresses no organization, so `installTenantFetch`
 * leaves them alone and they reach the root `/api/tenant-discovery*` routes.
 */

export interface DiscoveredOrganization {
  /** Only present when several results share a name; the host and path that tells them apart. */
  address?: string;
  id: string;
  name: string;
}

export type OrganizationLookupErrorCode =
  /** 409 HANDOFF_EXISTS: this desktop sign-in request was already used for another organization. */
  'handoffExpired' | 'invalidEmail' | 'notAvailable' | 'rateLimited' | 'unavailable';

export class OrganizationLookupError extends Error {
  constructor(
    readonly code: OrganizationLookupErrorCode,
    /** Seconds from the `Retry-After` header of a rate-limited response. */
    readonly retryAfter?: number,
  ) {
    super(code);
    this.name = 'OrganizationLookupError';
  }
}

const DISCOVERY_PATH = '/api/tenant-discovery';
const SELECT_PATH = `${DISCOVERY_PATH}/select`;

const parseRetryAfter = (header: string | null): number | undefined => {
  if (!header || !/^\d+$/.test(header.trim())) return undefined;
  const seconds = Number.parseInt(header, 10);
  return seconds > 0 ? seconds : undefined;
};

const readErrorCode = async (response: Response): Promise<string | undefined> => {
  try {
    const body = (await response.json()) as { code?: unknown } | null;
    return typeof body?.code === 'string' ? body.code : undefined;
  } catch {
    return undefined;
  }
};

const toLookupError = async (response: Response): Promise<OrganizationLookupError> => {
  if (response.status === 429)
    return new OrganizationLookupError(
      'rateLimited',
      parseRetryAfter(response.headers.get('Retry-After')),
    );
  if (response.status === 400) return new OrganizationLookupError('invalidEmail');
  if (response.status === 409 && (await readErrorCode(response)) === 'HANDOFF_EXISTS')
    return new OrganizationLookupError('handoffExpired');
  if (response.status === 404 && (await readErrorCode(response)) === 'TENANT_NOT_AVAILABLE')
    return new OrganizationLookupError('notAvailable');
  // 503 TENANT_DISCOVERY_UNAVAILABLE, 403 ORIGIN_REJECTED and anything unexpected: retryable.
  return new OrganizationLookupError('unavailable');
};

const postJson = async (path: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
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
    throw new OrganizationLookupError('unavailable');
  }

  if (!response.ok) throw await toLookupError(response);

  try {
    return await response.json();
  } catch {
    throw new OrganizationLookupError('unavailable');
  }
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

/** Organizations the email belongs to, in the order the server returned them. */
export const discoverOrganizations = async (
  email: string,
  signal?: AbortSignal,
): Promise<DiscoveredOrganization[]> => {
  const data = (await postJson(DISCOVERY_PATH, { email }, signal)) as {
    tenants?: unknown;
  } | null;
  const tenants = data?.tenants;
  if (!Array.isArray(tenants) || !tenants.every((item) => isOrganization(item)))
    throw new OrganizationLookupError('unavailable');
  return tenants.map(({ address, id, name }) => ({ ...(address ? { address } : {}), id, name }));
};

/**
 * The sign-in URL of the chosen organization (for a desktop sign-in, its authorization URL);
 * the server also remembers the choice.
 */
export const selectOrganization = async (
  params: { desktop?: { codeChallenge: string; state: string }; email?: string; id: string },
  signal?: AbortSignal,
): Promise<string> => {
  const data = (await postJson(SELECT_PATH, params, signal)) as { url?: unknown } | null;
  if (typeof data?.url !== 'string') throw new OrganizationLookupError('unavailable');
  try {
    // Only ever navigate to a web address, whatever the response carried.
    const url = new URL(data.url, window.location.href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('unsupported');
    // An absolute address is passed on exactly as the server wrote it: an authorization URL
    // is built from a fixed parameter list and must not be re-serialised on the way.
    return /^https?:\/\//i.test(data.url) ? data.url : url.toString();
  } catch {
    throw new OrganizationLookupError('unavailable');
  }
};

/** Carries the viewer's language to a page that has no language cookie of its own yet. */
export const withLanguage = (url: string, language: string | undefined): string => {
  if (!language) return url;
  const target = new URL(url);
  if (!target.searchParams.has('hl')) target.searchParams.set('hl', language);
  return target.toString();
};
