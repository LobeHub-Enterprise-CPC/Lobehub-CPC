/**
 * Tenant gate refusals that mean the workspace itself is closed (frozen, expired,
 * offline, not provisioned, destroyed). Auth pages explain the workspace state for these rather
 * than treating them as an unknown account, an unverified email or a generic failure.
 */
const TENANT_UNAVAILABLE_CODES = new Set([
  'TENANT_DESTROYED',
  'TENANT_EXPIRED',
  'TENANT_FROZEN',
  'TENANT_NOT_FOUND',
  'TENANT_NOT_READY',
  'TENANT_OFFLINE',
]);

export const isTenantUnavailableCode = (code: unknown): boolean =>
  typeof code === 'string' && TENANT_UNAVAILABLE_CODES.has(code);

/** Reads the gate's `{ code }` body of a failed response; any other failure is not a refusal. */
export const isTenantUnavailableResponse = async (response: Response): Promise<boolean> => {
  if (response.ok) return false;
  try {
    const body = (await response.json()) as { code?: unknown } | null;
    return isTenantUnavailableCode(body?.code);
  } catch {
    return false;
  }
};
