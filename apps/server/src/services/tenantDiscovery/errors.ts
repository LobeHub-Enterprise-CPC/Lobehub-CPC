export type DiscoveryErrorCode =
  | 'HANDOFF_EXISTS'
  | 'HANDOFF_NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'ORIGIN_REJECTED'
  | 'TENANT_NOT_AVAILABLE'
  | 'RATE_LIMITED'
  | 'TENANT_DISCOVERY_UNAVAILABLE'
  | 'NOT_FOUND';
export class DiscoveryError extends Error {
  constructor(
    public readonly code: DiscoveryErrorCode,
    public readonly status: number,
    public readonly retryAfter?: number,
  ) {
    super(code);
  }
}
export const unavailable = () => new DiscoveryError('TENANT_DISCOVERY_UNAVAILABLE', 503);
