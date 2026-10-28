import { type MarketSDK } from '@lobehub/market-sdk';

/**
 * Raised when something tries to act as an organization (the
 * `x-lobe-owner-account-id` header, a `workspace:<id>` organization endpoint)
 * inside a tenant. Market closes acting-as-organization for a tenant (R13) and
 * refuses such requests; refusing here first keeps the caller from believing it
 * wrote as the organization when the request would have run as the person.
 */
export class MarketActingAsOrganizationUnavailableError extends Error {
  constructor(operation: string) {
    super(`MARKET_ACTING_AS_ORGANIZATION_UNAVAILABLE:${operation}`);
    this.name = 'MarketActingAsOrganizationUnavailableError';
  }
}

/**
 * Wraps an SDK so its organization surface (`organizations.*`, the
 * `workspace:<id>` path family) refuses to be reached. Everything else, the
 * personal surface included, passes through untouched.
 */
export const guardOrganizationActing = (sdk: MarketSDK): MarketSDK =>
  new Proxy(sdk, {
    get(target, property, receiver) {
      if (property === 'organizations') {
        throw new MarketActingAsOrganizationUnavailableError('organizations');
      }
      return Reflect.get(target, property, receiver);
    },
  });
