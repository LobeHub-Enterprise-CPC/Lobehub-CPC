import { describe, expect, it } from 'vitest';

import { getMarketProfileKey } from './profileKey';

describe('getMarketProfileKey', () => {
  it('looks the profile up by the numeric account id', () => {
    expect(getMarketProfileKey({ accountId: 42, sub: 'user_1' }, true)).toBe('42');
    expect(getMarketProfileKey({ accountId: 42, sub: 'user_1' }, false)).toBe('42');
  });

  // In a tenant `sub` is the user's id in the tenant's account space, not a username.
  it('never falls back to sub inside a tenant document', () => {
    expect(getMarketProfileKey({ accountId: 0, sub: 'user_1' }, true)).toBeNull();
    expect(getMarketProfileKey({ accountId: undefined as never, sub: 'user_1' }, true)).toBeNull();
  });

  it('keeps sub as the username of a community deployment that sent no account id', () => {
    expect(getMarketProfileKey({ accountId: 0, sub: 'ada' }, false)).toBe('ada');
  });

  it('has no key without a user', () => {
    expect(getMarketProfileKey(null)).toBeNull();
    expect(getMarketProfileKey(undefined)).toBeNull();
  });
});
