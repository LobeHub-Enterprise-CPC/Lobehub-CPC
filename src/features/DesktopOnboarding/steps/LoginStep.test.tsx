import type {
  AuthorizationConfirmRequest,
  CloudTenantDisplay,
  DataSyncConfig,
  TenantEndpointChangedKind,
} from '@lobechat/electron-client-ipc';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LoginStep from './LoginStep';

const mockElectronState = vi.hoisted(() => ({
  cancelAuthorizationConfirmation: vi.fn(),
  clearRemoteServerSyncError: vi.fn(),
  confirmAuthorization: vi.fn(),
  connectRemoteServer: vi.fn(),
  dataSyncConfig: { active: true, storageMode: 'cloud' } as DataSyncConfig,
  dismissAuthorizationConfirmation: vi.fn(),
  isConnectingServer: false,
  pendingAuthorizationConfirmation: undefined as AuthorizationConfirmRequest | undefined,
  refreshServerConfig: vi.fn(),
  remoteServerSyncError: undefined as { code?: string; message?: string } | undefined,
  requestPlatformAuthorization: vi.fn(),
  setPendingAuthorizationConfirmation: vi.fn(),
  setTenantEndpointChanged: vi.fn(),
  switchAuthorizationOrganization: vi.fn(),
  switchOrganization: vi.fn(),
  tenantEndpointChanged: undefined as TenantEndpointChangedKind | undefined,
  useDataSyncConfig: vi.fn(() => ({})),
}));

const mockSignOut = vi.hoisted(() => vi.fn());
const mockGetPendingConfirmation = vi.hoisted(() => vi.fn());
const broadcastHandlers = vi.hoisted(() => new Map<string, (payload?: any) => void>());

vi.mock('@lobechat/electron-client-ipc', () => ({
  useWatchBroadcast: (event: string, handler: (payload?: any) => void) => {
    broadcastHandlers.set(event, handler);
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | Record<string, string>) => {
      const dict: Record<string, string> = {
        'authResult.failed.desc': 'Authorization failed',
        'authResult.failed.title': 'Authorization Failed',
        // Retired key, kept so the "no success banner" assertion below can still fail loudly
        'authResult.success.title': 'Authorization Successful',
        'back': 'Back',
        'next': 'Next',
        'screen5.actions.cancel': 'Cancel',
        'screen5.actions.connectToServer': 'Connect to server',
        'screen5.actions.done': 'Done',
        'screen5.actions.signInCloud': 'Sign in Cloud',
        'screen5.actions.signOut': 'Sign out',
        'screen5.actions.findByOrganizationEmail': 'Find by organization email',
        'screen5.actions.signInAgain': 'Sign in again',
        'screen5.actions.signingIn': 'Signing in...',
        'screen5.actions.switchOrganization': 'Switch organization',
        'screen5.actions.tryAgain': 'Try again',
        'screen5.auth.phase.awaitingConfirmation': 'Waiting for your confirmation',
        'screen5.auth.phase.restarting': 'Reconnecting {{attempt}}/{{max}}',
        'screen5.auth.phase.waitingForOrganization': 'Choose your organization in the browser',
        'screen5.confirm.confirm': 'Confirm',
        'screen5.confirm.expired': 'Confirmation expired',
        'screen5.confirm.remaining': 'Expires in {{time}}',
        'screen5.confirm.switchOrganization': 'Choose another organization',
        'screen5.confirm.title': 'Sign in to this organization?',
        'screen5.endpointChanged.relogin.title': 'Organization address changed',
        'screen5.endpointChanged.updateAddress.title': 'Server address changed',
        'screen5.errors.invalidOrganizationAddress': 'Not a valid organization address',
        'screen5.errors.platformUnavailable': 'Service unavailable',
        'screen5.errors.timedOut': 'Authorization timed out',
        'screen5.notice.sessionKept': 'Your current sign-in is still active',
        'close': 'Close',
        'screen5.identity.account': 'Account',
        'screen5.identity.address': 'Address',
        'screen5.identity.organization': 'Organization',
        'screen5.identity.organizationWithSlug': '{{name}} ({{slug}})',
        'screen5.description':
          'Sign in to sync Agents, Groups, settings, and Context across all devices.',
        'screen5.methods.selfhost.description': 'Use self-hosted server',
        'screen5.selfhost.endpointPlaceholder': 'https://example.com',
        'screen5.status.cloud.title': 'Connected to your organization',
        'screen5.status.description': 'Everything is syncing across all your devices.',
        'screen5.status.selfhost.description': 'Syncing with {{url}}.',
        'screen5.status.selfhost.title': 'Connected to your own server',
        'screen5.title': 'Sign in to sync across devices',
        'screen5.title2': '',
        'screen5.title3': '',
      };

      const template = dict[key] ?? (typeof options === 'string' ? options : key);

      if (!options || typeof options === 'string') return template;

      return Object.entries(options).reduce(
        (acc, [name, value]) => acc.replaceAll(`{{${name}}}`, String(value)),
        template,
      );
    },
  }),
}));

vi.mock('@/const/version', () => ({
  isDesktop: true,
}));

vi.mock('@/features/User/UserInfo', () => ({
  default: () => <div>User Info</div>,
}));

vi.mock('@/hooks/useIMECompositionEvent', () => ({
  useIMECompositionEvent: () => ({
    compositionProps: {},
    isComposingRef: { current: false },
  }),
}));

vi.mock('@/hooks/useSignOut', () => ({
  useSignOut: () => mockSignOut,
}));

vi.mock('@/services/electron/remoteServer', () => ({
  remoteServerService: {
    cancelAuthorization: vi.fn(),
    getPendingAuthorizationConfirmation: mockGetPendingConfirmation,
  },
}));

vi.mock('@/services/electron/system', () => ({
  electronSystemService: {
    hasLegacyLocalDb: vi.fn().mockResolvedValue(false),
    openExternalLink: vi.fn(),
    showContextMenu: vi.fn(),
  },
}));

vi.mock('@/store/electron', () => ({
  useElectronStore: Object.assign(
    <T,>(selector: (state: typeof mockElectronState) => T) => selector(mockElectronState),
    {
      getState: () => mockElectronState,
      setState: (patch: Partial<typeof mockElectronState>) =>
        Object.assign(mockElectronState, patch),
    },
  ),
}));

vi.mock('@/utils/electron/autoOidc', () => ({
  setDesktopAutoOidcFirstOpenHandled: vi.fn(),
}));

vi.mock('../components/LobeMessage', () => ({
  default: ({ sentences }: { sentences: string[] }) => (
    <div>{sentences.filter(Boolean).join(' ')}</div>
  ),
}));

const renderLoginStep = async (props: { mode?: 'onboarding' | 'status' } = {}) => {
  const onBack = vi.fn();
  const onNext = vi.fn();

  const { unmount } = render(<LoginStep onBack={onBack} onNext={onNext} {...props} />);

  return { onBack, onNext, unmount };
};

beforeEach(() => {
  for (const value of Object.values(mockElectronState)) {
    if (typeof value === 'function') (value as ReturnType<typeof vi.fn>).mockClear();
  }
  mockElectronState.cancelAuthorizationConfirmation.mockResolvedValue(undefined);
  mockElectronState.confirmAuthorization.mockResolvedValue({ success: true });
  mockElectronState.dataSyncConfig = { active: true, storageMode: 'cloud' };
  mockElectronState.isConnectingServer = false;
  mockElectronState.pendingAuthorizationConfirmation = undefined;
  mockElectronState.remoteServerSyncError = undefined;
  mockElectronState.switchAuthorizationOrganization.mockResolvedValue({ success: true });
  mockElectronState.switchOrganization.mockReset();
  mockElectronState.tenantEndpointChanged = undefined;
  mockSignOut.mockClear();
  mockSignOut.mockResolvedValue(undefined);
  mockGetPendingConfirmation.mockReset();
  mockGetPendingConfirmation.mockResolvedValue(null);
  broadcastHandlers.clear();
});

const emit = (event: string, payload?: unknown) => {
  act(() => {
    broadcastHandlers.get(event)?.(payload);
  });
};

const cloudTenantConfig = (display: CloudTenantDisplay): DataSyncConfig => ({
  active: true,
  cloudTenant: {
    display,
    entryUrl: 'https://work.example.com/t/acme',
    generation: 'gen-1',
    identity: { issuer: 'https://work.example.com', subject: 'sub-1', tenantId: 'tenant-1' },
  },
  storageMode: 'cloud',
});

const pendingRequest = (overrides: Partial<AuthorizationConfirmRequest> = {}) =>
  ({
    account: 'li@acme.example',
    confirmationId: 'confirm-1',
    entryUrl: 'https://work.example.com/t/acme',
    expiresAt: Date.now() + 5 * 60_000,
    generation: 'gen-1',
    name: 'Acme Corp',
    ...overrides,
  }) satisfies AuthorizationConfirmRequest;

afterEach(() => {
  cleanup();
});

describe('Desktop onboarding LoginStep', () => {
  it('renders a focused success state without an authorization banner', async () => {
    await renderLoginStep();

    expect(screen.queryByText('Authorization Successful')).not.toBeInTheDocument();
    expect(screen.getByText('User Info')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
    expect(screen.queryByText('OR')).not.toBeInTheDocument();
    expect(screen.queryByText('Use self-hosted server')).not.toBeInTheDocument();
  });

  it('leaves the success state through the host in onboarding mode instead of resetting to the chooser', async () => {
    const { onBack } = await renderLoginStep();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Sign in Cloud' })).not.toBeInTheDocument();
    expect(screen.getByText('User Info')).toBeInTheDocument();
  });

  it('renders a connection summary instead of the sign-in wizard in status mode', async () => {
    const { onNext } = await renderLoginStep({ mode: 'status' });

    expect(screen.getByText('Connected to your organization')).toBeInTheDocument();
    expect(screen.getByText('Everything is syncing across all your devices.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('names the self-hosted server it is connected to in status mode', async () => {
    mockElectronState.dataSyncConfig = {
      active: true,
      remoteServerUrl: 'https://my-server.example.com',
      storageMode: 'selfHost',
    };

    await renderLoginStep({ mode: 'status' });

    expect(screen.getByText('Connected to your own server')).toBeInTheDocument();
    expect(screen.getByText('Syncing with https://my-server.example.com.')).toBeInTheDocument();
  });

  it('signs out through the shared flow in status mode rather than faking a logged-out screen', async () => {
    await renderLoginStep({ mode: 'status' });

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Sign in Cloud' })).not.toBeInTheDocument();
  });

  describe('signed-in organization status', () => {
    it('shows the organization, entry address and account from the confirmed record', async () => {
      mockElectronState.dataSyncConfig = cloudTenantConfig({
        account: 'li@acme.example',
        organizationName: 'Acme Corp',
      });

      await renderLoginStep({ mode: 'status' });

      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
      expect(screen.getByText('https://work.example.com/t/acme')).toBeInTheDocument();
      expect(screen.getByText('li@acme.example')).toBeInTheDocument();
    });

    it('shows "name (slug)" when both are known, and only one when the other is missing', async () => {
      mockElectronState.dataSyncConfig = cloudTenantConfig({
        account: 'li@acme.example',
        organizationName: 'Acme Corp',
        organizationSlug: 'acme',
      });
      const { unmount } = await renderLoginStep({ mode: 'status' });
      expect(screen.getByText('Acme Corp (acme)')).toBeInTheDocument();
      unmount();

      mockElectronState.dataSyncConfig = cloudTenantConfig({
        account: 'li@acme.example',
        organizationSlug: 'acme',
      });
      const second = await renderLoginStep({ mode: 'status' });
      expect(screen.getByText('acme')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
      second.unmount();

      mockElectronState.dataSyncConfig = cloudTenantConfig({
        account: 'li@acme.example',
        organizationName: 'Acme Corp',
      });
      await renderLoginStep({ mode: 'status' });
      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    });

    it.each([
      ['true', true, true],
      ['false', false, false],
      ['unknown', undefined, true],
    ])(
      'offers organization switching by the committed flag when it is %s',
      async (_n, flag, shown) => {
        mockElectronState.dataSyncConfig = cloudTenantConfig({
          account: 'li@acme.example',
          ...(flag === undefined ? {} : { hasOtherOrganizations: flag }),
        });

        await renderLoginStep({ mode: 'status' });

        expect(!!screen.queryByRole('button', { name: 'Switch organization' })).toBe(shown);
        expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
      },
    );

    it('omits the organization row when the entry was known and has no display name', async () => {
      mockElectronState.dataSyncConfig = cloudTenantConfig({ account: 'li@acme.example' });

      await renderLoginStep({ mode: 'status' });

      expect(screen.queryByText('Organization')).not.toBeInTheDocument();
      expect(screen.getByText('https://work.example.com/t/acme')).toBeInTheDocument();
    });

    it('switches organization through the store and shows the new sign-in as in progress', async () => {
      mockElectronState.dataSyncConfig = cloudTenantConfig({ account: 'li@acme.example' });

      await renderLoginStep({ mode: 'status' });
      fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));

      expect(mockElectronState.switchOrganization).toHaveBeenCalledTimes(1);
      // The old summary must not stay up while main signs out and restarts the flow.
      expect(screen.queryByText('li@acme.example')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();
    });

    it('does not offer organization switching for a self-hosted server', async () => {
      mockElectronState.dataSyncConfig = {
        active: true,
        remoteServerUrl: 'https://my-server.example.com',
        storageMode: 'selfHost',
      };

      await renderLoginStep({ mode: 'status' });

      expect(screen.queryByRole('button', { name: 'Switch organization' })).not.toBeInTheDocument();
    });
  });

  describe('authorization confirmation', () => {
    beforeEach(() => {
      mockElectronState.dataSyncConfig = { storageMode: 'cloud' };
    });

    it('shows organization name, entry address and account for the platform flow', async () => {
      mockElectronState.pendingAuthorizationConfirmation = pendingRequest();

      await renderLoginStep();

      expect(screen.getByText('Sign in to this organization?')).toBeInTheDocument();
      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
      expect(screen.getByText('https://work.example.com/t/acme')).toBeInTheDocument();
      expect(screen.getByText('li@acme.example')).toBeInTheDocument();
    });

    it('shows only entry address and account when the entry was already known', async () => {
      mockElectronState.pendingAuthorizationConfirmation = pendingRequest({ name: undefined });

      await renderLoginStep();

      expect(screen.queryByText('Organization')).not.toBeInTheDocument();
      expect(screen.getByText('https://work.example.com/t/acme')).toBeInTheDocument();
      expect(screen.getByText('li@acme.example')).toBeInTheDocument();
    });

    it('shows "name (slug)" from this login, and only the slug when there is no name', async () => {
      mockElectronState.pendingAuthorizationConfirmation = pendingRequest({ slug: 'acme' });
      const { unmount } = await renderLoginStep();
      expect(screen.getByText('Acme Corp (acme)')).toBeInTheDocument();
      unmount();

      mockElectronState.pendingAuthorizationConfirmation = pendingRequest({
        name: undefined,
        slug: 'acme',
      });
      await renderLoginStep();
      expect(screen.getByText('acme')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
    });

    it.each([
      ['this login says true', { hasOtherOrganizations: true }, undefined, true],
      ['this login says false', { hasOtherOrganizations: false }, undefined, false],
      ['this login says nothing', {}, undefined, true],
      ['this login says nothing, whatever the committed record says', {}, false, true],
      [
        'this login says true, whatever the committed record says',
        { hasOtherOrganizations: true },
        false,
        true,
      ],
      [
        'this login says false, whatever the committed record says',
        { hasOtherOrganizations: false },
        true,
        false,
      ],
    ])(
      'offers "choose another organization" only by this login when %s',
      async (_name, requestFlag, committedFlag, shown) => {
        mockElectronState.dataSyncConfig = cloudTenantConfig({
          account: 'old@acme.example',
          ...(committedFlag === undefined ? {} : { hasOtherOrganizations: committedFlag }),
        });
        mockElectronState.pendingAuthorizationConfirmation = pendingRequest(requestFlag);

        await renderLoginStep();

        expect(!!screen.queryByRole('button', { name: 'Choose another organization' })).toBe(shown);
        expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
      },
    );

    it('confirms, switches and cancels through the store without sending identity data', async () => {
      mockElectronState.pendingAuthorizationConfirmation = pendingRequest();

      await renderLoginStep();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      });
      expect(mockElectronState.confirmAuthorization).toHaveBeenCalledWith();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Choose another organization' }));
      });
      expect(mockElectronState.switchAuthorizationOrganization).toHaveBeenCalledWith();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      });
      expect(mockElectronState.cancelAuthorizationConfirmation).toHaveBeenCalledWith();
    });

    it('closes the card and shows the failure when the commit failed, because main consumed the request', async () => {
      mockElectronState.pendingAuthorizationConfirmation = pendingRequest();
      mockElectronState.confirmAuthorization.mockImplementation(async () => {
        mockElectronState.pendingAuthorizationConfirmation = undefined;
        mockElectronState.remoteServerSyncError = { code: 'COMMIT_FAILED', message: 'disk full' };
        return { code: 'COMMIT_FAILED', error: 'disk full', success: false };
      });

      await renderLoginStep();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      });

      expect(screen.queryByText('Sign in to this organization?')).not.toBeInTheDocument();
      expect(screen.getByText('screen5.errors.commitFailed')).toBeInTheDocument();
      expect(screen.queryByText(/disk full/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    });

    it('shows an invalid confirmation as a sign-in error instead of a dead card', async () => {
      mockElectronState.pendingAuthorizationConfirmation = pendingRequest();
      mockElectronState.confirmAuthorization.mockImplementation(async () => {
        mockElectronState.pendingAuthorizationConfirmation = undefined;
        mockElectronState.remoteServerSyncError = {
          code: 'CONFIRMATION_INVALID',
          message: 'stale',
        };
        return { code: 'CONFIRMATION_INVALID', error: 'stale', success: false };
      });

      await renderLoginStep();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      });

      expect(screen.queryByText('Sign in to this organization?')).not.toBeInTheDocument();
      expect(screen.getByText('screen5.errors.confirmationInvalid')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('pulls a confirmation that was requested before this panel mounted', async () => {
      const request = pendingRequest();
      mockGetPendingConfirmation.mockResolvedValue(request);

      await act(async () => {
        await renderLoginStep();
      });

      expect(mockElectronState.setPendingAuthorizationConfirmation).toHaveBeenCalledWith(request);
    });

    it('mirrors confirm-required and dismissed broadcasts into the store', async () => {
      await renderLoginStep();
      const request = pendingRequest();

      emit('authorizationConfirmRequired', request);
      expect(mockElectronState.setPendingAuthorizationConfirmation).toHaveBeenCalledWith(request);

      emit('authorizationConfirmDismissed', { confirmationId: 'confirm-1', reason: 'expired' });
      expect(mockElectronState.dismissAuthorizationConfirmation).toHaveBeenCalledWith('confirm-1');
    });
  });

  describe('sign-in progress and errors', () => {
    beforeEach(() => {
      mockElectronState.dataSyncConfig = { storageMode: 'cloud' };
    });

    const startCloudLogin = async () => {
      await renderLoginStep();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Sign in Cloud' }));
      });
    };

    it('describes the organization-selection and confirmation phases', async () => {
      await startCloudLogin();

      emit('authorizationProgress', {
        elapsed: 0,
        maxPollTime: 600_000,
        phase: 'waiting_for_organization',
      });
      expect(screen.getByText('Choose your organization in the browser')).toBeInTheDocument();

      emit('authorizationProgress', {
        elapsed: 0,
        maxPollTime: 300_000,
        phase: 'awaiting_confirmation',
      });
      expect(screen.getByText('Waiting for your confirmation')).toBeInTheDocument();
    });

    it('keeps loading with a hint while main restarts after an address change', async () => {
      await startCloudLogin();

      emit('authorizationRestarting', { attempt: 1, maxAttempts: 2 });

      expect(screen.getByText('Reconnecting 1/2')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();
    });

    it('offers the organization-email lookup when the address is not an organization', async () => {
      await startCloudLogin();

      emit('authorizationFailed', {
        code: 'INVALID_ORGANIZATION_ADDRESS',
        error: 'preflight failed',
      });

      expect(screen.getByText('Not a valid organization address')).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Find by organization email' }));
      });
      expect(mockElectronState.requestPlatformAuthorization).toHaveBeenCalledTimes(1);
    });

    it('offers an explicit switch when the organization changed during recovery', async () => {
      await startCloudLogin();

      emit('authorizationFailed', { code: 'ORGANIZATION_CHANGED_SWITCH_REQUIRED', error: 'x' });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
      });
      expect(mockElectronState.switchOrganization).toHaveBeenCalledTimes(1);
    });

    it('shows copy by code, never the English technical message', async () => {
      await startCloudLogin();

      emit('authorizationFailed', { code: 'PLATFORM_UNAVAILABLE', error: 'ECONNRESET 10.0.0.1' });

      expect(screen.getByText('Service unavailable')).toBeInTheDocument();
      expect(screen.queryByText(/ECONNRESET/)).not.toBeInTheDocument();
    });

    it('ignores a superseded flow instead of reporting a failure', async () => {
      await startCloudLogin();

      emit('authorizationFailed', { code: 'FLOW_SUPERSEDED', error: 'superseded' });

      expect(screen.queryByText('Authorization Failed')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();
    });

    it('adopts a login started elsewhere when its progress arrives', async () => {
      await renderLoginStep();
      expect(screen.getByRole('button', { name: 'Sign in Cloud' })).toBeInTheDocument();

      emit('authorizationProgress', {
        elapsed: 0,
        maxPollTime: 120_000,
        phase: 'waiting_for_auth',
      });

      expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();
    });
  });

  describe('a failed switch or reconnect while signed in', () => {
    beforeEach(() => {
      mockElectronState.dataSyncConfig = cloudTenantConfig({
        account: 'li@acme.example',
        organizationName: 'Acme Corp',
        organizationSlug: 'acme',
      });
    });

    const expectSessionStillShown = () => {
      expect(screen.getByText('Acme Corp (acme)')).toBeInTheDocument();
      expect(screen.getByText('https://work.example.com/t/acme')).toBeInTheDocument();
      expect(screen.getByText('li@acme.example')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sign in Cloud' })).not.toBeInTheDocument();
    };

    const startSwitch = async () => {
      await renderLoginStep({ mode: 'status' });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
      });
    };

    it('keeps the signed-in summary and shows a notice when the switch times out via broadcast', async () => {
      await startSwitch();
      // The session summary yields to the sign-in progress only while it is running.
      expect(screen.queryByText('li@acme.example')).not.toBeInTheDocument();

      emit('authorizationFailed', { code: 'AUTHORIZATION_TIMEOUT', error: 'timed out' });

      expectSessionStillShown();
      expect(screen.getByRole('alert')).toHaveTextContent('Authorization timed out');
      expect(screen.getByRole('alert')).toHaveTextContent('Your current sign-in is still active');
      expect(screen.getByRole('button', { name: 'Switch organization' })).toBeEnabled();
    });

    it('keeps the signed-in summary when the switch result arrives through the store', async () => {
      mockElectronState.switchOrganization.mockImplementation(async () => {
        mockElectronState.remoteServerSyncError = {
          code: 'AUTHORIZATION_TIMEOUT',
          message: 'timed out',
        };
      });

      await startSwitch();

      expectSessionStillShown();
      expect(screen.getByRole('alert')).toHaveTextContent('Authorization timed out');
    });

    it('lets the user dismiss the notice and switch again', async () => {
      await startSwitch();
      emit('authorizationFailed', { code: 'PLATFORM_UNAVAILABLE', error: 'down' });
      expect(screen.getByRole('alert')).toHaveTextContent('Service unavailable');

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(mockElectronState.clearRemoteServerSyncError).toHaveBeenCalled();
      expectSessionStillShown();

      mockElectronState.switchOrganization.mockClear();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
      });
      expect(mockElectronState.switchOrganization).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();
    });

    it('offers the explicit switch in the notice even when no other organization is known', async () => {
      mockElectronState.dataSyncConfig = cloudTenantConfig({
        account: 'li@acme.example',
        hasOtherOrganizations: false,
      });
      mockElectronState.pendingAuthorizationConfirmation = pendingRequest({
        hasOtherOrganizations: true,
      });
      mockElectronState.switchAuthorizationOrganization.mockImplementation(async () => {
        mockElectronState.pendingAuthorizationConfirmation = undefined;
        mockElectronState.remoteServerSyncError = {
          code: 'ORGANIZATION_CHANGED_SWITCH_REQUIRED',
          message: 'x',
        };
        return { code: 'ORGANIZATION_CHANGED_SWITCH_REQUIRED', error: 'x', success: false };
      });

      await renderLoginStep({ mode: 'status' });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Choose another organization' }));
      });

      expect(screen.getByText('li@acme.example')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Switch organization' })).toHaveLength(1);
    });

    it('shows a single switch entry when the failure requires an explicit switch', async () => {
      await startSwitch();

      emit('authorizationFailed', { code: 'ORGANIZATION_CHANGED_SWITCH_REQUIRED', error: 'x' });

      expectSessionStillShown();
      expect(screen.getAllByRole('button', { name: 'Switch organization' })).toHaveLength(1);
      mockElectronState.switchOrganization.mockClear();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
      });
      expect(mockElectronState.switchOrganization).toHaveBeenCalledTimes(1);
    });

    it('returns to the summary without a notice when the switch is cancelled', async () => {
      await startSwitch();

      emit('authorizationProgress', { elapsed: 0, maxPollTime: 1000, phase: 'cancelled' });

      expectSessionStillShown();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('keeps waiting when the switch was superseded by a newer sign-in', async () => {
      await startSwitch();

      emit('authorizationFailed', { code: 'FLOW_SUPERSEDED', error: 'superseded' });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();
    });

    it('keeps the summary when the confirmation card fails to commit on top of a session', async () => {
      mockElectronState.pendingAuthorizationConfirmation = pendingRequest();
      mockElectronState.confirmAuthorization.mockImplementation(async () => {
        mockElectronState.pendingAuthorizationConfirmation = undefined;
        mockElectronState.remoteServerSyncError = { code: 'COMMIT_FAILED', message: 'disk full' };
        return { code: 'COMMIT_FAILED', error: 'disk full', success: false };
      });

      await renderLoginStep({ mode: 'status' });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
      });

      expect(screen.queryByText('Sign in to this organization?')).not.toBeInTheDocument();
      expectSessionStillShown();
      expect(screen.getByRole('alert')).toHaveTextContent('screen5.errors.commitFailed');
      expect(screen.queryByText(/disk full/)).not.toBeInTheDocument();
    });

    it('keeps the summary when the confirmation card is cancelled', async () => {
      mockElectronState.pendingAuthorizationConfirmation = pendingRequest();
      mockElectronState.cancelAuthorizationConfirmation.mockImplementation(async () => {
        mockElectronState.pendingAuthorizationConfirmation = undefined;
      });

      await renderLoginStep({ mode: 'status' });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      });

      expectSessionStillShown();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows the failure on the re-login panel instead of swallowing it', async () => {
      mockElectronState.tenantEndpointChanged = 'relogin_required';
      await renderLoginStep({ mode: 'status' });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
      });
      expect(screen.getByRole('button', { name: /Signing in/ })).toBeDisabled();

      emit('authorizationFailed', { code: 'PLATFORM_UNAVAILABLE', error: 'down' });

      expect(screen.getByText('Organization address changed')).toBeInTheDocument();
      expect(screen.getByText('li@acme.example')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign in again' })).toBeEnabled();
      expect(
        screen
          .getAllByRole('alert')
          .map((n) => n.textContent)
          .join(' '),
      ).toContain('Service unavailable');
    });
  });

  describe('organization address changed while signed in', () => {
    it('asks to sign in again when the organization entry moved, and re-logins on the cloud flow', async () => {
      mockElectronState.dataSyncConfig = cloudTenantConfig({ account: 'li@acme.example' });
      mockElectronState.tenantEndpointChanged = 'relogin_required';

      await renderLoginStep({ mode: 'status' });

      expect(screen.getByText('Organization address changed')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
      });
      expect(mockElectronState.connectRemoteServer).toHaveBeenCalledWith(
        expect.objectContaining({ storageMode: 'cloud' }),
      );
    });

    it('names the organization with its slug in the re-login panel', async () => {
      mockElectronState.dataSyncConfig = cloudTenantConfig({
        account: 'li@acme.example',
        organizationName: 'Acme Corp',
        organizationSlug: 'acme',
      });
      mockElectronState.tenantEndpointChanged = 'relogin_required';

      await renderLoginStep({ mode: 'status' });

      expect(screen.getByText('Acme Corp (acme)')).toBeInTheDocument();
    });

    it('re-logins a self-hosted organization entry on its own address', async () => {
      mockElectronState.dataSyncConfig = {
        active: true,
        remoteServerUrl: 'https://custom.example.com',
        storageMode: 'selfHost',
      };
      mockElectronState.tenantEndpointChanged = 'relogin_required';

      await renderLoginStep({ mode: 'status' });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
      });

      expect(mockElectronState.connectRemoteServer).toHaveBeenCalledWith({
        remoteServerUrl: 'https://custom.example.com',
        storageMode: 'selfHost',
      });
    });

    it('asks a self-hosted user to update the server address, prefilled, without the cloud lookup', async () => {
      mockElectronState.dataSyncConfig = {
        active: true,
        remoteServerUrl: 'https://old.example.com',
        storageMode: 'selfHost',
      };
      mockElectronState.tenantEndpointChanged = 'update_address_required';

      await renderLoginStep({ mode: 'status' });

      expect(screen.getByText('Server address changed')).toBeInTheDocument();
      expect(screen.getByDisplayValue('https://old.example.com')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Find by organization email' }),
      ).not.toBeInTheDocument();
    });
  });
});
