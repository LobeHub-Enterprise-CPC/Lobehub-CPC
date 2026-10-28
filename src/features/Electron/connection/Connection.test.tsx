import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Connection from './Connection';

const state = vi.hoisted(() => ({
  isConnectionDrawerOpen: false,
  pendingAuthorizationConfirmation: undefined as { confirmationId: string } | undefined,
  setConnectionDrawerOpen: vi.fn(),
  tenantEndpointChanged: undefined as string | undefined,
}));
const syncHook = vi.hoisted(() => vi.fn());

vi.mock('@/store/electron', () => ({
  useElectronStore: <T,>(selector: (s: typeof state) => T) => selector(state),
}));

vi.mock('@/features/DesktopOnboarding/hooks/useAuthorizationEventsSync', () => ({
  useAuthorizationEventsSync: syncHook,
}));

vi.mock('@/features/DesktopOnboarding/steps/LoginStep', () => ({
  default: () => <div>login step</div>,
}));

vi.mock('./RemoteStatus', () => ({ default: () => <div>remote status</div> }));

vi.mock('@/components/Loading', () => ({ BrandTextLoading: () => null }));

vi.mock('@/utils/platform', () => ({ isMacOS: () => false }));

beforeEach(() => {
  state.isConnectionDrawerOpen = false;
  state.pendingAuthorizationConfirmation = undefined;
  state.setConnectionDrawerOpen.mockClear();
  state.tenantEndpointChanged = undefined;
  syncHook.mockClear();
});

afterEach(cleanup);

describe('Connection', () => {
  it('keeps listening for authorization events while the drawer is closed', () => {
    render(<Connection />);

    expect(syncHook).toHaveBeenCalled();
    expect(state.setConnectionDrawerOpen).not.toHaveBeenCalled();
  });

  it('opens the panel when a login waits for confirmation', () => {
    state.pendingAuthorizationConfirmation = { confirmationId: 'c1' };

    render(<Connection />);

    expect(state.setConnectionDrawerOpen).toHaveBeenCalledWith(true);
  });

  it.each(['relogin_required', 'update_address_required'])(
    'opens the panel when the organization entry moved (%s)',
    (kind) => {
      state.tenantEndpointChanged = kind;

      render(<Connection />);

      expect(state.setConnectionDrawerOpen).toHaveBeenCalledWith(true);
    },
  );
});
