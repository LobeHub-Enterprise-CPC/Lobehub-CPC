import '../initialize';

import { RouterProvider } from 'react-router/dom';

import BootErrorBoundary from '@/components/BootErrorBoundary';
import NextThemeProvider from '@/layout/GlobalProvider/NextThemeProvider';
import { bootTiming } from '@/libs/bootTiming';
import { createAppRouter } from '@/utils/router';

import { resolveAppBasename } from './appBasename';
import BootShell from './BootShell';
import { isMainLayoutLocation } from './BootShell/routeScope';
import { startAppInitialization } from './initialize/bootstrap';
import { desktopRoutes } from './router/desktopRouter.config';
import { createSPARoot } from './runtime';

bootTiming.mark('bundle-eval');
startAppInitialization();

// The tenant prefix rides the same mechanism as the debug proxy — see
// `appBasename.ts` for why a basename rather than a route segment.
const { basename } = resolveAppBasename({
  debugProxy: window.__DEBUG_PROXY__,
  pathname: window.location.pathname,
});

const router = createAppRouter(desktopRoutes, { basename });

// Mounting is conditional rather than an early return inside the shell: the hook
// also strips the static logo, and a standalone route needs that logo to stay up
// until its own brand-loading fallback takes over.
const showBootShell = isMainLayoutLocation(desktopRoutes, window.location.pathname, basename);

createSPARoot(document.getElementById('root')!).render(
  <BootErrorBoundary>
    <NextThemeProvider>
      {showBootShell && <BootShell />}
      <RouterProvider router={router} />
    </NextThemeProvider>
  </BootErrorBoundary>,
);
