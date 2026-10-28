import { getTenantScopeId, setRemoteTenantId } from '@lobechat/business-tenant/client';

import type { ElectronState } from './initialState';
import { electronSyncSelectors } from './selectors';

/**
 * Keep the desktop renderer's browser-local state (tabs, pins, recents, drafts, cache scope)
 * partitioned by the organization it is signed in to.
 *
 * - First committed organization (or the one preload reported at boot): adopt it as the partition.
 * - A different organization committed in this renderer: reload at the app root instead of
 *   adopting it. The in-memory tabs and stores belong to the previous organization; adopting the
 *   new partition under them would write A's tabs into B's bucket. The reload boots from preload's
 *   token identity, which already names the new organization.
 * - Signed out: the partition stays on the last organization until another one is committed.
 */
export const syncTenantPartition = (
  state: ElectronState,
  reload: () => void = () => window.location.replace('/'),
): void => {
  if (!state.isInitRemoteServerConfig) return;

  const next = electronSyncSelectors.committedTenantId(state);
  if (!next) return;

  const current = getTenantScopeId();
  if (!current) return setRemoteTenantId(next);
  if (current !== next) reload();
};
