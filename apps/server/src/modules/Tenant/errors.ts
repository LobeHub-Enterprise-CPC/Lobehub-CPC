import { TenantDatabaseError } from '@lobechat/database/tenant';

/**
 * Refusals at the tenant gate (spec FR-ID-07, FR-RT-04, FR-DI-03). Each code
 * maps to one HTTP status; the body is `{ code }` (plus freeze reasons for a
 * frozen tenant) and never names a schema, host or credential.
 */
export type TenantGateCode =
  | 'TENANT_DESTROYED'
  | 'TENANT_EXPIRED'
  | 'TENANT_FROZEN'
  | 'TENANT_INVALID'
  | 'TENANT_MISMATCH'
  | 'TENANT_NOT_FOUND'
  | 'TENANT_NOT_READY'
  | 'TENANT_OFFLINE'
  | 'TENANT_REQUIRED'
  | 'TENANT_UNAVAILABLE';

export const TENANT_GATE_STATUS: Record<TenantGateCode, number> = {
  // The tenant UUID is under destruction (barrier established) or destroyed: no retry can succeed.
  TENANT_DESTROYED: 409,
  TENANT_EXPIRED: 403,
  TENANT_FROZEN: 403,
  TENANT_INVALID: 400,
  TENANT_MISMATCH: 403,
  TENANT_NOT_FOUND: 404,
  TENANT_NOT_READY: 503,
  TENANT_OFFLINE: 403,
  TENANT_REQUIRED: 400,
  TENANT_UNAVAILABLE: 503,
};

/**
 * Where a refusal comes from, for callers that must tell "this tenant is not admitted" apart from
 * "the platform failed while checking" (the root session entry: the first is shown as an
 * unavailable organization, the second is a retryable failure and never a missing session).
 * Lifecycle refusals are admission; a raiser marks the other admission refusals explicitly.
 * Everything else, including wrapped database and endpoint failures, is infrastructure.
 */
export type TenantGateSource = 'admission' | 'infrastructure';

const ADMISSION_CODES: ReadonlySet<TenantGateCode> = new Set([
  'TENANT_EXPIRED',
  'TENANT_FROZEN',
  'TENANT_OFFLINE',
]);

export class TenantGateError extends Error {
  readonly source: TenantGateSource;

  constructor(
    readonly code: TenantGateCode,
    readonly detail?: { freezeReasons?: string[] },
    options?: ErrorOptions & { source?: TenantGateSource },
  ) {
    super(code, options);
    this.name = 'TenantGateError';
    this.source = options?.source ?? (ADMISSION_CODES.has(code) ? 'admission' : 'infrastructure');
  }

  get status() {
    return TENANT_GATE_STATUS[this.code];
  }

  toResponse(): Response {
    return Response.json(
      {
        code: this.code,
        ...(this.detail?.freezeReasons && { reasons: this.detail.freezeReasons }),
      },
      {
        headers: {
          'Cache-Control': 'private, no-store',
          ...(this.status === 503 && { 'Retry-After': '5' }),
        },
        status: this.status,
      },
    );
  }
}

/**
 * The gate refusal behind `error`, looking through wrappers such as Drizzle's
 * query error: work admitted earlier is refused when its next transaction
 * re-checks the tenant, deep inside the database driver. A tenant database
 * refusal is the gate refusal with the same code.
 */
export const tenantGateErrorOf = (error: unknown): TenantGateError | undefined => {
  for (let current = error, depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof TenantGateError) return current;
    if (current instanceof TenantDatabaseError)
      return new TenantGateError(current.code, undefined, { cause: current });
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

/**
 * The gate's `{ code }` response for a refusal raised inside a handler, so a
 * handler's own catch-all never turns a closed workspace into a generic failure.
 */
export const tenantRefusalResponse = (error: unknown): Response | undefined =>
  tenantGateErrorOf(error)?.toResponse();
