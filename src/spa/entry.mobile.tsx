import '../initialize';

import { RouterProvider } from 'react-router/dom';

import NextThemeProvider from '@/layout/GlobalProvider/NextThemeProvider';
import { bootTiming } from '@/libs/bootTiming';
import { createAppRouter } from '@/utils/router';

import { resolveAppBasename } from './appBasename';
import { startAppInitialization } from './initialize/bootstrap';
import { mobileRoutes } from './router/mobileRouter.config';
import { createSPARoot } from './runtime';

bootTiming.mark('bundle-eval');
startAppInitialization();

// Mobile had no basename at all, so a tenant-prefixed url would have had its
// `/t/{slug}` eaten by the `:workspaceSlug` segment and rendered the wrong page
// without erroring. Same resolver as web.
const { basename } = resolveAppBasename({
  debugProxy: window.__DEBUG_PROXY__,
  pathname: window.location.pathname,
});

const router = createAppRouter(mobileRoutes, { basename });

createSPARoot(document.getElementById('root')!).render(
  <NextThemeProvider>
    <RouterProvider router={router} />
  </NextThemeProvider>,
);
