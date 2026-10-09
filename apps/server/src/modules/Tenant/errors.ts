/**
 * Refusals at the tenant gate (spec FR-ID-07, FR-RT-04, FR-DI-03). Each code
 * maps to one HTTP status; the body is `{ code }` (plus freeze reasons for a
 * frozen tenant) and never names a schema, host or credential.
 */
export type TenantGateCode =
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

export class TenantGateError extends Error {
  constructor(
    readonly code: TenantGateCode,
    readonly detail?: { freezeReasons?: string[] },
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'TenantGateError';
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
