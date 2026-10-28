import { TenantGateError } from './errors';

const ROUTING_UNAVAILABLE_REASONS = [
  'ROUTING_ABORTED',
  'ROUTING_GENERATION_CHANGED',
  'ROUTING_LOAD_EXPIRED',
  'ROUTING_LOOKUP_FAILED',
  'ROUTING_SNAPSHOT_MISSING',
] as const;

export type RoutingUnavailableReason = (typeof ROUTING_UNAVAILABLE_REASONS)[number];

export class TenantRoutingUnavailableError extends TenantGateError {
  constructor(
    readonly reason: RoutingUnavailableReason,
    options?: ErrorOptions,
  ) {
    super('TENANT_UNAVAILABLE', undefined, options);
    this.name = 'TenantRoutingUnavailableError';
  }
}

/** Only our typed, closed reasons may reach logs; external error fields are untrusted. */
export const routingUnavailableReasonOf = (
  error: unknown,
): RoutingUnavailableReason | 'UNKNOWN' => {
  if (!(error instanceof TenantRoutingUnavailableError)) return 'UNKNOWN';
  const reason = Object.getOwnPropertyDescriptor(error, 'reason')?.value;
  return ROUTING_UNAVAILABLE_REASONS.includes(reason) ? reason : 'UNKNOWN';
};
