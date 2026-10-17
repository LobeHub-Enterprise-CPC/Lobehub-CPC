/**
 * Whether "switch organization" is worth offering, from a `hasOtherOrganizations` flag.
 * Only an explicit `false` hides the entry: unknown (`undefined`) keeps it, so a server that
 * does not report the flag never loses the way out.
 */
export const canOfferOrganizationSwitch = (hasOtherOrganizations?: boolean): boolean =>
  hasOtherOrganizations !== false;
