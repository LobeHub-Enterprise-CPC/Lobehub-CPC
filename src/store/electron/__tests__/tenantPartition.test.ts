import { getTenantScopeId, setRemoteTenantId } from '@lobechat/business-tenant/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ElectronState, initialState } from '../initialState';
import { syncTenantPartition } from '../tenantPartition';

const stateOf = (tenantId?: string, hydrated = true): ElectronState => ({
  ...initialState,
  dataSyncConfig: {
    active: true,
    storageMode: 'cloud',
    ...(tenantId && {
      cloudTenant: {
        display: { account: 's' },
        entryUrl: `https://host/orgs/${tenantId}`,
        generation: 'g',
        identity: { issuer: 'https://host/oidc', subject: 's', tenantId },
      },
    }),
  },
  isInitRemoteServerConfig: hydrated,
});

afterEach(() => setRemoteTenantId(undefined));

describe('syncTenantPartition', () => {
  it('adopts the first committed organization without reloading', () => {
    const reload = vi.fn();

    syncTenantPartition(stateOf('tenant-a'), reload);

    expect(getTenantScopeId()).toBe('tenant-a');
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads instead of adopting a different organization under the old in-memory state', () => {
    setRemoteTenantId('tenant-a');
    const reload = vi.fn();

    syncTenantPartition(stateOf('tenant-b'), reload);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(getTenantScopeId()).toBe('tenant-a');
  });

  it('does nothing for the same organization, before hydration, or while signed out', () => {
    setRemoteTenantId('tenant-a');
    const reload = vi.fn();

    syncTenantPartition(stateOf('tenant-a'), reload);
    syncTenantPartition(stateOf('tenant-b', false), reload);
    syncTenantPartition(stateOf(undefined), reload);

    expect(reload).not.toHaveBeenCalled();
    expect(getTenantScopeId()).toBe('tenant-a');
  });
});
