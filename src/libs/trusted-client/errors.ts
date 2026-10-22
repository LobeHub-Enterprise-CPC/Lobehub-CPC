export type TrustedClientIdentityErrorCode =
  /**
   * The session lookup itself failed (as opposed to finding no session): whether
   * the visitor is signed in is unknown, so the request must not go out as an
   * anonymous one.
   */
  | 'SESSION_UNAVAILABLE'
  /** The user row is gone, or has no email: nobody to sign for. */
  | 'USER_UNAVAILABLE'
  /** Tenant mode, but the trusted client id or secret is not configured: nothing to sign with. */
  | 'TRUST_NOT_CONFIGURED'
  /** The signer rejected the configured secret or payload. */
  | 'TRUST_SIGNING_FAILED'
  /** Tenant mode: the request has no trust token, and the legacy Bearer / no credentials are not an alternative. */
  | 'TRUST_TOKEN_REQUIRED'
  /** The identity was assembled under one tenant and is being signed under another. */
  | 'TENANT_MISMATCH'
  /** Signing outside any tenant scope with an identity that does not carry its tenant. */
  | 'TENANT_REQUIRED'
  /** The tenant id cannot be expressed in Market's `tenantId` claim (`[A-Za-z0-9_.-]{1,64}`). */
  | 'TENANT_ID_UNSUPPORTED';

/**
 * Market identity could not be assembled although trusted-client auth is
 * enabled. Distinct from "trusted client is not enabled", which is a
 * configuration the caller falls back from: this is a failure, and the caller
 * must neither sign a token without the tenant nor retry as an OIDC user, or
 * the request would reach Market as a different principal than the one asked.
 */
export class TrustedClientIdentityError extends Error {
  constructor(
    readonly code: TrustedClientIdentityErrorCode,
    options?: ErrorOptions,
  ) {
    super(`MARKET_IDENTITY_UNAVAILABLE:${code}`, options);
    this.name = 'TrustedClientIdentityError';
  }
}
