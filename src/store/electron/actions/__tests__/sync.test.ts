import type { DataSyncConfig } from '@lobechat/electron-client-ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { remoteServerService } from '@/services/electron/remoteServer';
import { useElectronStore } from '@/store/electron';
import { stores } from '@/store/utils/userDataStores';

vi.mock('@/services/electron/remoteServer', () => ({
  remoteServerService: {
    cancelAuthorizationConfirmation: vi.fn(),
    clearRemoteServerConfig: vi.fn(),
    confirmAuthorization: vi.fn(),
    getRemoteServerConfig: vi.fn(),
    requestAuthorization: vi.fn(),
    requestPlatformAuthorization: vi.fn(),
    setRemoteServerConfig: vi.fn(),
    switchAuthorizationOrganization: vi.fn(),
    switchOrganization: vi.fn(),
  },
}));

vi.mock('@/store/utils/userDataStores', () => ({ stores: { reset: vi.fn() } }));

vi.mock('@/libs/swr', () => ({ mutate: vi.fn() }));

const swr = vi.hoisted(() => ({
  onSuccess: undefined as undefined | ((data: unknown) => void),
}));
vi.mock('swr', () => ({
  default: vi.fn(
    (_key: unknown, _fetcher: unknown, options: { onSuccess: (data: unknown) => void }) => {
      swr.onSuccess = options.onSuccess;
      return {};
    },
  ),
}));

const service = vi.mocked(remoteServerService);
const request = {
  account: 'li@acme.example',
  confirmationId: 'confirm-1',
  entryUrl: 'https://work.example.com/orgs/acme',
  expiresAt: Date.now() + 300_000,
  generation: 'gen-1',
  name: 'Acme',
};

const state = () => useElectronStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useElectronStore.setState({
    pendingAuthorizationConfirmation: request,
    remoteServerSyncError: undefined,
    tenantEndpointChanged: undefined,
  });
});

describe('authorization confirmation actions', () => {
  it('replies with only the confirmation id and generation, and drops the card on success', async () => {
    service.confirmAuthorization.mockResolvedValue({ success: true });

    await state().confirmAuthorization();

    expect(service.confirmAuthorization).toHaveBeenCalledWith({
      confirmationId: 'confirm-1',
      generation: 'gen-1',
    });
    expect(state().pendingAuthorizationConfirmation).toBeUndefined();
  });

  it.each(['CONFIRMATION_INVALID', 'CONFIRMATION_TIMEOUT'] as const)(
    'drops the card and records the reason when main reports %s',
    async (code) => {
      service.confirmAuthorization.mockResolvedValue({ code, error: 'gone', success: false });

      await state().confirmAuthorization();

      expect(state().pendingAuthorizationConfirmation).toBeUndefined();
      expect(state().remoteServerSyncError).toMatchObject({ code, type: 'AUTH_ERROR' });
    },
  );

  it('drops the card when the commit failed, since main consumed the pending request', async () => {
    service.confirmAuthorization.mockResolvedValue({
      code: 'COMMIT_FAILED',
      error: 'write failed',
      success: false,
    });

    const result = await state().confirmAuthorization();

    expect(result).toMatchObject({ code: 'COMMIT_FAILED', success: false });
    expect(state().pendingAuthorizationConfirmation).toBeUndefined();
    expect(state().remoteServerSyncError).toMatchObject({ code: 'COMMIT_FAILED' });
  });

  it('does not call main when there is nothing to confirm', async () => {
    useElectronStore.setState({ pendingAuthorizationConfirmation: undefined });

    const result = await state().confirmAuthorization();

    expect(result).toMatchObject({ code: 'CONFIRMATION_INVALID', success: false });
    expect(service.confirmAuthorization).not.toHaveBeenCalled();
  });

  it('does not let a late reply for an old card dismiss a newer one', () => {
    useElectronStore.setState({
      pendingAuthorizationConfirmation: { ...request, confirmationId: 'confirm-2' },
    });

    state().dismissAuthorizationConfirmation('confirm-1');
    expect(state().pendingAuthorizationConfirmation?.confirmationId).toBe('confirm-2');

    state().dismissAuthorizationConfirmation('confirm-2');
    expect(state().pendingAuthorizationConfirmation).toBeUndefined();
  });

  it('cancels with the same two fields and always closes the card', async () => {
    service.cancelAuthorizationConfirmation.mockRejectedValue(new Error('ipc down'));

    await state().cancelAuthorizationConfirmation();

    expect(service.cancelAuthorizationConfirmation).toHaveBeenCalledWith({
      confirmationId: 'confirm-1',
      generation: 'gen-1',
    });
    expect(state().pendingAuthorizationConfirmation).toBeUndefined();
  });

  it('chooses another organization without signing out or resetting user data', async () => {
    service.switchAuthorizationOrganization.mockResolvedValue({ success: true });

    await state().switchAuthorizationOrganization();

    expect(service.switchAuthorizationOrganization).toHaveBeenCalledWith({
      confirmationId: 'confirm-1',
      generation: 'gen-1',
    });
    expect(stores.reset).not.toHaveBeenCalled();
    expect(state().pendingAuthorizationConfirmation).toBeUndefined();
  });

  it('records why choosing another organization could not start', async () => {
    service.switchAuthorizationOrganization.mockResolvedValue({
      code: 'PLATFORM_UNAVAILABLE',
      error: 'down',
      success: false,
    });

    await state().switchAuthorizationOrganization();

    expect(state().remoteServerSyncError).toMatchObject({ code: 'PLATFORM_UNAVAILABLE' });
  });
});

describe('switchOrganization', () => {
  it('only starts a new platform flow: the signed-in session and its user data stay untouched', async () => {
    useElectronStore.setState({ tenantEndpointChanged: 'relogin_required' });
    service.switchOrganization.mockResolvedValue({ success: true });

    await state().switchOrganization();

    expect(service.switchOrganization).toHaveBeenCalledTimes(1);
    expect(service.clearRemoteServerConfig).not.toHaveBeenCalled();
    expect(service.setRemoteServerConfig).not.toHaveBeenCalled();
    expect(stores.reset).not.toHaveBeenCalled();
    // The paused-session notice belongs to the session that is still committed.
    expect(state().tenantEndpointChanged).toBe('relogin_required');
    expect(state().pendingAuthorizationConfirmation).toBeUndefined();
    expect(state().isConnectingServer).toBe(false);
  });

  it('keeps user data when the new flow fails to start, because nothing was signed out', async () => {
    service.switchOrganization.mockResolvedValue({
      code: 'PLATFORM_UNAVAILABLE',
      error: 'down',
      success: false,
    });

    await state().switchOrganization();

    expect(stores.reset).not.toHaveBeenCalled();
    expect(state().remoteServerSyncError).toMatchObject({ code: 'PLATFORM_UNAVAILABLE' });
  });
});

describe('connectRemoteServer', () => {
  const committed: DataSyncConfig = {
    active: true,
    cloudTenant: {
      display: { account: 'a@acme.example' },
      entryUrl: 'https://work.example.com/orgs/acme',
      generation: 'gen-a',
      identity: { issuer: 'https://work.example.com/orgs/acme/oidc', subject: 'u1', tenantId: 'a' },
    },
    storageMode: 'cloud',
  };

  it('hands the new config to the flow without writing it over the committed one', async () => {
    service.getRemoteServerConfig.mockResolvedValue(committed);
    service.requestAuthorization.mockResolvedValue({ success: true });
    const next: DataSyncConfig = {
      remoteServerUrl: 'https://other.example.com/orgs/b',
      storageMode: 'selfHost',
    };

    await state().connectRemoteServer(next);

    expect(service.requestAuthorization).toHaveBeenCalledWith(next);
    expect(service.setRemoteServerConfig).not.toHaveBeenCalled();
    expect(service.clearRemoteServerConfig).not.toHaveBeenCalled();
    expect(stores.reset).not.toHaveBeenCalled();
  });

  it('leaves the committed session alone when the attempt fails', async () => {
    service.getRemoteServerConfig.mockResolvedValue(committed);
    service.requestAuthorization.mockResolvedValue({
      code: 'INVALID_ORGANIZATION_ADDRESS',
      error: 'nope',
      success: false,
    });

    await state().connectRemoteServer({
      remoteServerUrl: 'https://other.example.com/orgs/b',
      storageMode: 'selfHost',
    });

    expect(service.setRemoteServerConfig).not.toHaveBeenCalled();
    expect(service.clearRemoteServerConfig).not.toHaveBeenCalled();
    expect(stores.reset).not.toHaveBeenCalled();
    expect(state().remoteServerSyncError).toMatchObject({ code: 'INVALID_ORGANIZATION_ADDRESS' });
  });
});

describe('user data follows the committed identity only', () => {
  const sessionA: DataSyncConfig = {
    active: true,
    cloudTenant: {
      display: { account: 'a@acme.example' },
      entryUrl: 'https://work.example.com/orgs/acme',
      generation: 'gen-a',
      identity: { issuer: 'https://work.example.com/orgs/acme/oidc', subject: 'u1', tenantId: 'a' },
    },
    storageMode: 'cloud',
  };

  it('resets user data when B replaces A, and not while B is only being chosen', async () => {
    const refreshUserData = vi.fn().mockResolvedValue(undefined);
    useElectronStore.setState({ isInitRemoteServerConfig: false, refreshUserData });
    state().useDataSyncConfig();
    swr.onSuccess?.(sessionA);

    // Choosing B, then cancelling / failing: main leaves the config as it was.
    service.switchOrganization.mockResolvedValue({ success: true });
    await state().switchOrganization();
    swr.onSuccess?.({ ...sessionA });
    expect(refreshUserData).not.toHaveBeenCalled();

    // B is confirmed: the committed config changes.
    swr.onSuccess?.({
      ...sessionA,
      cloudTenant: { ...sessionA.cloudTenant!, generation: 'gen-b' },
    });
    expect(refreshUserData).toHaveBeenCalledTimes(1);
  });
});

describe('failure codes reach the store', () => {
  it('treats a superseded request as benign instead of an error', async () => {
    service.switchOrganization.mockResolvedValue({
      code: 'FLOW_SUPERSEDED',
      error: 'superseded',
      success: false,
    });
    service.requestPlatformAuthorization.mockResolvedValue({
      code: 'FLOW_SUPERSEDED',
      error: 'superseded',
      success: false,
    });

    await state().switchOrganization();
    await state().requestPlatformAuthorization();

    expect(state().remoteServerSyncError).toBeUndefined();
  });

  it('keeps the code of a failed requestAuthorization', async () => {
    service.getRemoteServerConfig.mockResolvedValue({ storageMode: 'selfHost' });
    service.setRemoteServerConfig.mockResolvedValue(undefined as never);
    service.requestAuthorization.mockResolvedValue({
      code: 'INVALID_ORGANIZATION_ADDRESS',
      error: 'preflight failed',
      success: false,
    });

    await state().connectRemoteServer({
      remoteServerUrl: 'https://nope.example.com',
      storageMode: 'selfHost',
    });

    expect(state().remoteServerSyncError).toMatchObject({
      code: 'INVALID_ORGANIZATION_ADDRESS',
      type: 'AUTH_ERROR',
    });
  });

  it('keeps the code of a failed platform request', async () => {
    service.requestPlatformAuthorization.mockResolvedValue({
      code: 'PLATFORM_UNAVAILABLE',
      error: 'down',
      success: false,
    });

    await state().requestPlatformAuthorization();

    expect(state().remoteServerSyncError).toMatchObject({ code: 'PLATFORM_UNAVAILABLE' });
  });
});
