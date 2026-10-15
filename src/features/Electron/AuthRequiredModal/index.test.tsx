import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AuthRequiredModal, { useAuthRequiredModal } from './index';

interface ModalProps {
  content?: ReactNode;
  footer?: ReactNode;
  maskClosable?: boolean;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  styles?: {
    close?: React.CSSProperties;
  };
  title?: ReactNode;
}

const createModalMock = vi.hoisted(() => vi.fn());
const modalInstance = vi.hoisted(() => ({
  close: vi.fn(),
  update: vi.fn(),
}));
const translations = vi.hoisted(() => ({ current: {} as Record<string, string> }));
const broadcastHandlers = vi.hoisted(() => new Map<string, (payload?: any) => void>());
const electronStore = vi.hoisted(() => ({
  current: {
    clearRemoteServerSyncError: vi.fn(),
    connectRemoteServer: vi.fn(),
    dataSyncConfig: undefined as
      | {
          cloudTenant?: { display: { hasOtherOrganizations?: boolean } };
          remoteServerUrl?: string;
          storageMode?: string;
        }
      | undefined,
    isConnectionDrawerOpen: false,
    isInitRemoteServerConfig: true,
    pendingAuthorizationConfirmation: undefined as { confirmationId: string } | undefined,
    refreshServerConfig: vi.fn(),
    remoteServerSyncError: undefined as { code?: string; message?: string } | undefined,
    requestPlatformAuthorization: vi.fn(),
    switchOrganization: vi.fn(),
  },
}));

vi.mock('@lobechat/electron-client-ipc', () => ({
  useWatchBroadcast: (event: string, handler: (payload?: any) => void) => {
    broadcastHandlers.set(event, handler);
  },
}));

vi.mock('@lobehub/ui/base-ui', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createModal: (props: ModalProps) => {
    createModalMock(props);

    return modalInstance;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: (namespace?: string) => ({
    t: (key: string) => translations.current[`${namespace}:${key}`] ?? key,
  }),
}));

vi.mock('@/store/electron', () => {
  const useElectronStore = Object.assign(
    <T,>(selector: (state: typeof electronStore.current) => T): T =>
      selector(electronStore.current),
    { getState: () => electronStore.current },
  );

  return { useElectronStore };
});

describe('useAuthRequiredModal', () => {
  beforeEach(() => {
    createModalMock.mockClear();
    modalInstance.close.mockClear();
    modalInstance.update.mockClear();
    broadcastHandlers.clear();
    electronStore.current.clearRemoteServerSyncError.mockClear();
    electronStore.current.connectRemoteServer.mockReset();
    electronStore.current.refreshServerConfig.mockClear();
    electronStore.current.requestPlatformAuthorization.mockReset();
    electronStore.current.switchOrganization.mockReset();
    electronStore.current.dataSyncConfig = undefined;
    electronStore.current.pendingAuthorizationConfirmation = undefined;
    electronStore.current.remoteServerSyncError = undefined;
    translations.current = {};
  });

  it('closes the modal when desktop authorization succeeds', () => {
    render(<AuthRequiredModal />);

    act(() => {
      broadcastHandlers.get('authorizationRequired')?.({ reason: 'refresh:invalid_grant' });
    });

    expect(createModalMock).toHaveBeenCalledOnce();

    act(() => {
      broadcastHandlers.get('authorizationSuccessful')?.();
    });

    expect(modalInstance.close).toHaveBeenCalledOnce();
    expect(electronStore.current.refreshServerConfig).toHaveBeenCalledOnce();
  });

  it('renders the title from auth translations after the namespace becomes available', () => {
    const { result } = renderHook(() => useAuthRequiredModal());

    act(() => {
      result.current.open();
    });

    const [modalProps] = createModalMock.mock.calls[0] as [ModalProps];
    translations.current['auth:authModal.title'] = 'Session Expired';

    render(<>{modalProps.title}</>);

    expect(screen.getByText('Session Expired')).toBeInTheDocument();
    expect(screen.queryByText('authModal.title')).not.toBeInTheDocument();
  });

  it('keeps the close button available while removing the Later action', () => {
    translations.current = {
      'auth:authModal.later': 'Later',
      'auth:authModal.signIn': 'Sign In Again',
      'auth:authModal.signingIn': 'Signing in...',
    };
    const { result } = renderHook(() => useAuthRequiredModal());

    act(() => {
      result.current.open();
    });

    const [modalProps] = createModalMock.mock.calls[0] as [ModalProps];

    expect(modalProps.maskClosable).toBe(false);
    expect(modalProps.styles?.close).toBeUndefined();

    render(
      <>
        {modalProps.content}
        {modalProps.footer}
      </>,
    );

    expect(screen.queryByText('Later')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Sign In Again'));

    expect(electronStore.current.clearRemoteServerSyncError).toHaveBeenCalled();
    expect(electronStore.current.connectRemoteServer).toHaveBeenCalledWith({
      remoteServerUrl: undefined,
      storageMode: 'cloud',
    });

    act(() => {
      modalProps.onOpenChange?.(false);
    });

    act(() => {
      result.current.open();
    });

    expect(createModalMock).toHaveBeenCalledTimes(2);
  });

  describe('hand-off to the confirmation card and flow feedback', () => {
    const emit = (event: string, payload?: unknown) => {
      act(() => {
        broadcastHandlers.get(event)?.(payload);
      });
    };

    const openModal = () => {
      const { result } = renderHook(() => useAuthRequiredModal());
      act(() => {
        result.current.open();
      });
      const [modalProps] = createModalMock.mock.calls.at(-1) as [ModalProps];
      render(<>{modalProps.content}</>);

      return modalProps;
    };

    /** The footer button the user sees after the last modal update. */
    const footerLabel = (modalProps: ModalProps) => {
      const update = modalInstance.update.mock.calls.at(-1)?.[0] as { footer?: ReactNode };
      const { container, unmount } = render(<>{update?.footer ?? modalProps.footer}</>);
      const label = container.querySelector('button')?.textContent;
      unmount();

      return label;
    };

    const startSignIn = (modalProps: ModalProps) => {
      const { container, unmount } = render(<>{modalProps.footer}</>);
      fireEvent.click(container.querySelector('button')!);
      unmount();
    };

    beforeEach(() => {
      translations.current = {
        'auth:authModal.signIn': 'Sign In Again',
        'auth:authModal.signingIn': 'Signing in...',
        'desktop-onboarding:screen5.actions.findByOrganizationEmail': 'Find by organization email',
        'desktop-onboarding:screen5.actions.switchOrganization': 'Switch organization',
        'desktop-onboarding:screen5.auth.phase.awaitingConfirmation': 'Waiting for confirmation',
        'desktop-onboarding:screen5.auth.phase.restarting': 'Reconnecting',
        'desktop-onboarding:screen5.auth.phase.waitingForOrganization': 'Choose an organization',
        'desktop-onboarding:screen5.errors.generic': 'Generic failure',
        'desktop-onboarding:screen5.errors.invalidOrganizationAddress': 'Not an organization',
        'desktop-onboarding:screen5.errors.platformUnavailable': 'Service unavailable',
      };
    });

    it('closes when a verified login needs confirmation, so the card is not covered', () => {
      render(<AuthRequiredModal />);
      act(() => {
        broadcastHandlers.get('authorizationRequired')?.({ reason: 'refresh:invalid_grant' });
      });
      expect(createModalMock).toHaveBeenCalledOnce();

      emit('authorizationConfirmRequired', { confirmationId: 'c1' });

      expect(modalInstance.close).toHaveBeenCalledOnce();
    });

    it('closes when the store already holds a pending confirmation (late mount, reload)', () => {
      electronStore.current.pendingAuthorizationConfirmation = { confirmationId: 'c1' };

      render(<AuthRequiredModal />);

      expect(createModalMock).not.toHaveBeenCalled();
    });

    it('does not open over a pending confirmation', () => {
      electronStore.current.pendingAuthorizationConfirmation = { confirmationId: 'c1' };
      render(<AuthRequiredModal />);

      act(() => {
        broadcastHandlers.get('authorizationRequired')?.({ reason: 'refresh:invalid_grant' });
      });

      expect(createModalMock).not.toHaveBeenCalled();
    });

    it('shows the current phase while signing in', () => {
      const modalProps = openModal();
      startSignIn(modalProps);

      emit('authorizationProgress', {
        elapsed: 0,
        maxPollTime: 600_000,
        phase: 'waiting_for_organization',
      });
      expect(screen.getByText('Choose an organization')).toBeInTheDocument();

      emit('authorizationProgress', {
        elapsed: 0,
        maxPollTime: 300_000,
        phase: 'awaiting_confirmation',
      });
      expect(screen.getByText('Waiting for confirmation')).toBeInTheDocument();

      emit('authorizationRestarting', { attempt: 1, maxAttempts: 2 });
      expect(screen.getByText('Reconnecting')).toBeInTheDocument();
    });

    it('stops the spinner and clears the phase when the flow is cancelled', () => {
      const modalProps = openModal();
      startSignIn(modalProps);
      expect(footerLabel(modalProps)).toBe('Signing in...');

      emit('authorizationProgress', {
        elapsed: 0,
        maxPollTime: 600_000,
        phase: 'waiting_for_organization',
      });
      emit('authorizationProgress', { elapsed: 1, maxPollTime: 600_000, phase: 'cancelled' });

      expect(screen.queryByText('Choose an organization')).not.toBeInTheDocument();
      expect(footerLabel(modalProps)).toBe('Sign In Again');
    });

    it('shows copy for the failure code and stops the spinner', () => {
      const modalProps = openModal();
      startSignIn(modalProps);

      emit('authorizationFailed', { code: 'PLATFORM_UNAVAILABLE', error: 'ECONNRESET 10.0.0.1' });

      expect(screen.getByText('Service unavailable')).toBeInTheDocument();
      expect(screen.queryByText(/ECONNRESET/)).not.toBeInTheDocument();
      expect(footerLabel(modalProps)).toBe('Sign In Again');
    });

    it('falls back to generic copy for a code this build does not know', () => {
      const modalProps = openModal();
      startSignIn(modalProps);

      emit('authorizationFailed', { code: 'SOMETHING_NEW', error: 'x' });

      expect(screen.getByText('Generic failure')).toBeInTheDocument();
    });

    it('ignores a superseded flow and keeps signing in', () => {
      const modalProps = openModal();
      startSignIn(modalProps);

      emit('authorizationFailed', { code: 'FLOW_SUPERSEDED', error: 'superseded' });

      expect(screen.queryByText('Generic failure')).not.toBeInTheDocument();
      expect(footerLabel(modalProps)).toBe('Signing in...');
    });

    it('reports a start failure that main never broadcasts (address pre-check)', async () => {
      electronStore.current.connectRemoteServer.mockImplementation(async () => {
        electronStore.current.remoteServerSyncError = {
          code: 'INVALID_ORGANIZATION_ADDRESS',
          message: 'preflight failed',
        };
      });
      const modalProps = openModal();

      const { container, unmount } = render(<>{modalProps.footer}</>);
      await act(async () => {
        fireEvent.click(container.querySelector('button')!);
      });
      unmount();

      expect(screen.getByText('Not an organization')).toBeInTheDocument();
      expect(footerLabel(modalProps)).toBe('Sign In Again');
    });

    it('offers the organization-email lookup for an invalid organization address', async () => {
      const modalProps = openModal();
      startSignIn(modalProps);
      emit('authorizationFailed', { code: 'INVALID_ORGANIZATION_ADDRESS', error: 'x' });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Find by organization email' }));
      });

      expect(electronStore.current.requestPlatformAuthorization).toHaveBeenCalledTimes(1);
      expect(footerLabel(modalProps)).toBe('Signing in...');
    });

    it('offers an explicit switch when the organization changed during recovery', async () => {
      const modalProps = openModal();
      startSignIn(modalProps);
      emit('authorizationFailed', { code: 'ORGANIZATION_CHANGED_SWITCH_REQUIRED', error: 'x' });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Switch organization' }));
      });

      expect(electronStore.current.switchOrganization).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['true', true],
      ['false', false],
      ['unknown', undefined],
    ])(
      'always offers the explicit switch the server demands, whatever the committed flag is (%s)',
      (_name, flag) => {
        electronStore.current.dataSyncConfig = {
          cloudTenant: { display: flag === undefined ? {} : { hasOtherOrganizations: flag } },
          storageMode: 'cloud',
        };
        const modalProps = openModal();
        startSignIn(modalProps);
        emit('authorizationFailed', { code: 'ORGANIZATION_CHANGED_SWITCH_REQUIRED', error: 'x' });

        expect(screen.getByRole('button', { name: 'Switch organization' })).toBeInTheDocument();
      },
    );

    it('does not offer the switch for failures that do not demand it, even when the committed flag is true', () => {
      electronStore.current.dataSyncConfig = {
        cloudTenant: { display: { hasOtherOrganizations: true } },
        storageMode: 'cloud',
      };
      const modalProps = openModal();
      startSignIn(modalProps);
      emit('authorizationFailed', { code: 'PLATFORM_UNAVAILABLE', error: 'x' });

      expect(screen.queryByRole('button', { name: 'Switch organization' })).not.toBeInTheDocument();
    });
  });
});
