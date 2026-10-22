import { Center, cssVar, Drawer, Flexbox } from '@lobehub/ui';
import { Suspense, useCallback, useEffect } from 'react';

import { BrandTextLoading } from '@/components/Loading';
import { useAuthorizationEventsSync } from '@/features/DesktopOnboarding/hooks/useAuthorizationEventsSync';
import LoginStep from '@/features/DesktopOnboarding/steps/LoginStep';
import { useElectronStore } from '@/store/electron';
import { isMacOS } from '@/utils/platform';

import RemoteStatus from './RemoteStatus';

const isMac = isMacOS();

const Connection = () => {
  const [isOpen, setConnectionDrawerOpen, confirmationId, endpointChangedKind] = useElectronStore(
    (s) => [
      s.isConnectionDrawerOpen,
      s.setConnectionDrawerOpen,
      s.pendingAuthorizationConfirmation?.confirmationId,
      s.tenantEndpointChanged,
    ],
  );

  // This host is always mounted in the main window, so it must keep listening: a login can be
  // started from the session-expired modal, and a verified login or a moved organization entry
  // needs the user's attention wherever they are in the app.
  useAuthorizationEventsSync();

  useEffect(() => {
    if (confirmationId || endpointChangedKind) setConnectionDrawerOpen(true);
  }, [confirmationId, endpointChangedKind, setConnectionDrawerOpen]);

  const handleClose = useCallback(() => {
    setConnectionDrawerOpen(false);
  }, [setConnectionDrawerOpen]);

  return (
    <>
      <RemoteStatus
        onClick={() => {
          setConnectionDrawerOpen(true);
        }}
      />
      <Drawer
        noHeader
        height={'100vh'}
        open={isOpen}
        placement={'top'}
        style={{
          background: cssVar.colorBgLayout,
        }}
        styles={{
          bodyContent: { padding: 0 },
          // Clears the Electron title bar, which only overlaps the drawer off macOS.
          extra: { insetBlockStart: isMac ? 12 : 46, insetInlineEnd: 6 },
        }}
        onClose={handleClose}
      >
        <Suspense
          fallback={
            <Center style={{ height: '100%' }}>
              <BrandTextLoading debugId="Connection" />
            </Center>
          }
        >
          <Center style={{ height: '100%', overflow: 'auto', padding: 24 }}>
            <Flexbox style={{ maxWidth: 560, width: '100%' }}>
              <LoginStep mode={'status'} onBack={handleClose} onNext={handleClose} />
            </Flexbox>
          </Center>
        </Suspense>
      </Drawer>
    </>
  );
};

export default Connection;
