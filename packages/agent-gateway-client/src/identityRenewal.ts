import type { GatewayIdentityProvider, GatewayIdentityResponse } from '../../types/src/gateway';
import { assertGatewayIdentityContinuity, gatewayIdentityFailure } from './identity';
import type { GatewayConfirmation } from './tenancy';
import { GATEWAY_CLOCK_SKEW_MS, GatewaySocketAuthority } from './tenancy';

interface RenewalOptions {
  authority: GatewaySocketAuthority;
  isCurrent: () => boolean;
  onExpired: () => void;
  onFailed: (code: string) => void;
  onTemporary: (code: string) => void;
  provider?: GatewayIdentityProvider;
  sendAuth: (identity: GatewayIdentityResponse) => void;
}

/** One actual socket, one original provider, and gateway-confirmed authority only. */
export class GatewayIdentityRenewal {
  authority: GatewaySocketAuthority;
  private timer?: ReturnType<typeof setTimeout>;
  private expiry?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private candidate?: GatewaySocketAuthority;
  private stopped = false;
  private deadline = 0;
  private retry = 0;

  constructor(private readonly options: RenewalOptions) {
    this.authority = options.authority;
  }

  confirm(raw: unknown): boolean {
    const frame = raw as GatewayConfirmation;
    if (this.stopped || !this.options.isCurrent()) throw new Error('SOURCE_UNVERIFIABLE');
    const renewed = !!this.candidate;
    if (this.candidate) {
      if (!this.authority.alive()) throw new Error('LEASE_EXPIRED');
      if (frame.connectionGeneration !== this.authority.connectionGeneration! + 1)
        throw new Error('UNAUTHORIZED');
      this.candidate.confirm(frame);
      this.authority.invalidate();
      this.authority = this.candidate;
      this.candidate = undefined;
    } else this.authority.confirm(frame);
    this.plan();
    return renewed;
  }

  dispose() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.expiry);
    this.controller?.abort();
    this.candidate?.invalidate();
    this.candidate = undefined;
  }

  private plan() {
    clearTimeout(this.timer);
    clearTimeout(this.expiry);
    this.controller?.abort();
    this.retry = 0;
    if (!this.options.provider) return;
    const remaining = this.authority.identityDeadline - Date.now();
    this.deadline = performance.now() + remaining - GATEWAY_CLOCK_SKEW_MS;
    if (remaining <= GATEWAY_CLOCK_SKEW_MS) return this.expire();
    this.expiry = setTimeout(() => this.expire(), remaining - GATEWAY_CLOCK_SKEW_MS);
    this.timer = setTimeout(
      () => void this.renew(),
      Math.min(remaining / 2, remaining - GATEWAY_CLOCK_SKEW_MS),
    );
  }

  private remaining() {
    return Math.min(
      this.deadline - performance.now(),
      this.authority.identityDeadline - Date.now() - GATEWAY_CLOCK_SKEW_MS,
    );
  }

  private expire() {
    if (this.stopped || !this.options.isCurrent()) return;
    this.dispose();
    this.options.onExpired();
  }

  private async renew() {
    if (this.stopped || !this.options.isCurrent()) return;
    if (!this.authority.alive() || this.remaining() <= 0) return this.expire();
    const generation = this.authority.connectionGeneration;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const identity = await this.options.provider!({
        signal: controller.signal,
        renewAuthorizationId: this.authority.identity.authorizationId,
      });
      if (
        this.stopped ||
        controller.signal.aborted ||
        !this.options.isCurrent() ||
        generation !== this.authority.connectionGeneration
      )
        return;
      if (!this.authority.alive() || this.remaining() <= 0) return this.expire();
      assertGatewayIdentityContinuity(this.authority.identity, identity);
      if (
        Math.min(identity.ticketExpiresAt, identity.authRecordExpiresAt) <=
        Date.now() + GATEWAY_CLOCK_SKEW_MS
      )
        throw new Error('LEASE_EXPIRED');
      this.candidate = new GatewaySocketAuthority(
        identity,
        this.authority.audience,
        this.authority.operationId,
      );
      this.options.sendAuth(identity);
    } catch (error) {
      if (
        this.stopped ||
        controller.signal.aborted ||
        !this.options.isCurrent() ||
        generation !== this.authority.connectionGeneration
      )
        return;
      const failure = gatewayIdentityFailure(error);
      if (!failure.retryable) {
        this.dispose();
        this.options.onFailed(failure.code);
        return;
      }
      this.options.onTemporary(failure.code);
      if (!this.authority.alive() || this.remaining() <= GATEWAY_CLOCK_SKEW_MS)
        return this.expire();
      this.timer = setTimeout(
        () => void this.renew(),
        Math.min(30_000, 1000 * 2 ** this.retry++, this.remaining() / 2),
      );
    }
  }
}
