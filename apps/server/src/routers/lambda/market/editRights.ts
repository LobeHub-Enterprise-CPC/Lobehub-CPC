import { currentTenantScope } from '@lobechat/database/tenant';

import { type MarketEditCapabilities } from '@/types/discover';

export interface EditRights {
  canEdit: boolean;
  canUnpublish: boolean;
}

/**
 * Whether the requester may edit and unpublish a Market resource.
 *
 * In a multi-tenant deployment Market is the only source of authority: it
 * answers with the top-level `canEdit` / `canUnpublish` of the resource (the
 * verified personal account is the owner, or the session is the instance's
 * back-office administrator), and CPC only reads the answer. A response that
 * does not carry them grants nothing; nothing is inferred from owner, email,
 * namespace, super_admin or sync source.
 *
 * Outside a tenant scope the single-tenant rule stands: the owner may do both.
 */
export const resolveEditRights = (
  detail: MarketEditCapabilities | null | undefined,
  /** The single-tenant answer, evaluated by the caller only when it applies. */
  isOwner: () => boolean,
): EditRights => {
  if (currentTenantScope()) {
    return { canEdit: detail?.canEdit === true, canUnpublish: detail?.canUnpublish === true };
  }

  const owner = isOwner();
  return { canEdit: owner, canUnpublish: owner };
};
