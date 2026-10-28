import { describe, expect, it } from 'vitest';

import { canOfferOrganizationSwitch } from './organization';

describe('canOfferOrganizationSwitch', () => {
  it('hides the entry only for an explicit false', () => {
    expect(canOfferOrganizationSwitch(false)).toBe(false);
  });

  it('offers it for true and for an unknown value', () => {
    expect(canOfferOrganizationSwitch(true)).toBe(true);
    expect(canOfferOrganizationSwitch(undefined)).toBe(true);
    expect(canOfferOrganizationSwitch()).toBe(true);
  });
});
