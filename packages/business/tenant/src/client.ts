import { createStore } from 'zustand/vanilla';

import type { TenantContext } from './resolve';
import { resolveTenant } from './resolve';

interface TenantState {
  tenant: TenantContext | null;
}

// Document-local state: never persist a shared "current tenant" in cookies or localStorage.
const tenantStore = createStore<TenantState>(() => ({ tenant: null }));

/** Called by each browser entry before routing or issuing requests. */
export const initializeTenant = (url: URL): void => {
  tenantStore.setState({ tenant: resolveTenant(url) });
};

export const getTenant = (): TenantContext | null => tenantStore.getState().tenant;
