import { getTenant } from '@lobechat/business-tenant/client';

import { type MarketEditCapabilities } from '@/types/discover';

export interface MarketItemRights {
  canEdit: boolean;
  canUnpublish: boolean;
}

/**
 * Whether the signed-in user may edit and unpublish one Market item.
 *
 * In an organization (tenant) document Market is the only source of authority
 * and says so per item in the top-level `canEdit` / `canUnpublish`. The page
 * owner is no stand-in, and nothing is inferred from owner, email, namespace,
 * super_admin or sync source. A response that does not carry the fields grants
 * nothing.
 *
 * Without a tenant (community, desktop against a single-tenant server) the
 * profile owner may do both, as before.
 */
export const resolveItemRights = (
  item: MarketEditCapabilities,
  isProfileOwner: boolean,
  isTenantDocument: boolean = Boolean(getTenant()?.slug),
): MarketItemRights =>
  isTenantDocument
    ? { canEdit: item.canEdit === true, canUnpublish: item.canUnpublish === true }
    : { canEdit: isProfileOwner, canUnpublish: isProfileOwner };
