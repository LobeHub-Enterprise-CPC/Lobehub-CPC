import { generateTrustedClientToken, isTrustedClientEnabled } from '@/libs/trusted-client';
import { forEachTenant } from '@/server/modules/Tenant/fanOut';

const MARKET_BASE_URL = process.env.MARKET_BASE_URL || 'https://market.lobehub.com';
const PROBE_TIMEOUT_MS = 5_000;

/** The probe never reads or creates an account; the identity only has to be well formed. */
const PROBE_IDENTITY = { email: 'binding-probe@invalid.example', userId: 'tenant-binding-probe' };

export type MarketBindingProbe =
  /** Market admits the configured client into this tenant's instance. */
  | { clientId: string; slug?: string; status: 'bound' }
  /** 403 CLIENT_TENANT_MISMATCH: Console never bound the configured client id to the instance. */
  | { code: string; status: 'unbound' }
  /** Any other refusal (unknown client or wrong secret, frozen or offline instance, odd response). */
  | { code: string; httpStatus: number; status: 'refused' }
  /** 503: the instance is still being opened; retry later. */
  | { code: string; status: 'not-ready' }
  /** Network failure or timeout. */
  | { status: 'unreachable' }
  /** The token could not be signed for this tenant (the code says why). */
  | { code: string; status: 'unsigned' }
  /** The trusted client is not configured, so Market is not used with trust tokens. */
  | { status: 'skipped' };

interface ProbeDeps {
  baseUrl?: string;
  fetch?: typeof fetch;
}

const readRefusal = async (response: Response): Promise<string | undefined> => {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body?.error?.code === 'string' ? body.error.code : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Asks Market `GET /api/trusted-client/binding` whether a request signed for this tenant would be
 * admitted into its instance. It answers without creating or reading any account, so a client id
 * Console never bound to the tenant (or a wrong secret, a frozen instance) is visible before the
 * first user request fails as an anonymous 401. Never throws: every outcome is a result.
 */
export const probeMarketBinding = async (
  tenantId: string,
  { baseUrl = MARKET_BASE_URL, fetch: fetchImpl = fetch }: ProbeDeps = {},
): Promise<MarketBindingProbe> => {
  if (!isTrustedClientEnabled()) return { status: 'skipped' };

  let token: string | undefined;
  try {
    token = generateTrustedClientToken({ ...PROBE_IDENTITY, tenantId });
  } catch (error) {
    return {
      code: (error as { code?: string }).code ?? 'TRUST_SIGNING_FAILED',
      status: 'unsigned',
    };
  }
  if (!token) return { status: 'skipped' };

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/trusted-client/binding`, {
      headers: { 'x-lobe-trust-token': token },
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    // The error text can quote the URL; the status is all the caller needs.
    return { status: 'unreachable' };
  }

  if (response.ok) {
    const body = (await response.json().catch(() => null)) as {
      clientId?: unknown;
      ready?: unknown;
      slug?: unknown;
    } | null;
    if (body?.ready === true && typeof body.clientId === 'string') {
      return {
        clientId: body.clientId,
        ...(typeof body.slug === 'string' ? { slug: body.slug } : {}),
        status: 'bound',
      };
    }
    return { code: 'UNEXPECTED_RESPONSE', httpStatus: response.status, status: 'refused' };
  }

  const code = (await readRefusal(response)) ?? 'UNEXPECTED_RESPONSE';
  if (response.status === 503) return { code, status: 'not-ready' };
  if (response.status === 403 && code === 'CLIENT_TENANT_MISMATCH')
    return { code, status: 'unbound' };
  return { code, httpStatus: response.status, status: 'refused' };
};

const describeProblem = (probe: MarketBindingProbe): string | null => {
  switch (probe.status) {
    case 'unbound': {
      return `the configured Market trusted client is not bound to this tenant's Market instance (${probe.code}); Market requests will be refused until Console binds it`;
    }
    case 'refused': {
      return `Market refused the configured trusted client (${probe.code}, HTTP ${probe.httpStatus})`;
    }
    case 'not-ready': {
      return `the tenant's Market instance is not ready (${probe.code})`;
    }
    case 'unreachable': {
      return 'Market could not be reached for the trusted-client binding check';
    }
    case 'unsigned': {
      return `no trust token can be signed for this tenant (${probe.code})`;
    }
    default: {
      return null;
    }
  }
};

/**
 * Checks every available tenant once and warns for each one whose client is not usable, naming the
 * tenant and the code. Meant for startup, in the background: a Market problem is a warning here,
 * never a reason to keep a tenant (or the process) from starting.
 */
export const probeMarketBindingForAllTenants = async ({
  probe = probeMarketBinding,
}: { probe?: (tenantId: string) => Promise<MarketBindingProbe> } = {}) => {
  if (!isTrustedClientEnabled()) return;
  await forEachTenant('market-binding:probe', async (tenantId) => {
    const result = await probe(tenantId);
    const problem = describeProblem(result);
    if (problem) console.warn(`[market] tenant ${tenantId}: ${problem}`);
    return result;
  });
};
