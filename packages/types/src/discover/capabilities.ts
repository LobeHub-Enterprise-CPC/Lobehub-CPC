/**
 * What the requester may do with a Market resource, decided by Market from the
 * resource's owner and creator against the requesting identity.
 *
 * These belong to the requester, not the resource: they ride the uncached part
 * of a response and must never be derived from `ownerId` on this side. Absent
 * means "not granted" in a multi-tenant deployment; only a single-tenant
 * deployment may fall back to comparing owners.
 */
export interface MarketEditCapabilities {
  canEdit?: boolean;
  canUnpublish?: boolean;
}

/**
 * Whether a synced copy of a platform resource still follows the platform, as
 * Market reports it on the resource itself (`contentSync`, contract A2):
 *
 * - `null`: no sync binding, the resource was never a synced copy;
 * - `{ detached: false }`: still synced;
 * - `{ detached: true }`: edited or otherwise cut loose, no longer synced.
 *
 * Only the resource's own field counts (for a group detail that is
 * `.group.contentSync`), and it is never inferred from owner or `isOfficial`.
 * Absent means the response did not say (an older Market, or a path that does
 * not carry it); the UI treats it like "nothing to show".
 */
export type MarketContentSync = { detached: boolean } | null;

export interface MarketContentSyncState {
  contentSync?: MarketContentSync;
}
