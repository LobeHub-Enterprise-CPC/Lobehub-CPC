import { type MarketSDK } from '@lobehub/market-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  guardOrganizationActing,
  MarketActingAsOrganizationUnavailableError,
} from './organizationGuard';

const sdk = () =>
  ({
    creds: { list: vi.fn(() => 'personal') },
    organizations: { creds: vi.fn() },
  }) as unknown as MarketSDK;

describe('guardOrganizationActing', () => {
  it('refuses the organization surface with an explicit error', () => {
    const guarded = guardOrganizationActing(sdk());

    expect(() => guarded.organizations).toThrowError(MarketActingAsOrganizationUnavailableError);
    expect(() => guarded.organizations).toThrowError(
      'MARKET_ACTING_AS_ORGANIZATION_UNAVAILABLE:organizations',
    );
  });

  it('leaves the personal surface untouched', () => {
    const guarded = guardOrganizationActing(sdk());

    expect(guarded.creds.list()).toBe('personal');
  });
});
