// Like the main SPA entries: tenant fetch/asset prefixing (`/orgs/{slug}`) and the
// StyleX sheet. Without it every share read goes out unscoped (TENANT_REQUIRED).
import '@/initialize';

import { getTenant } from '@lobechat/business-tenant/client';
import { RouterProvider } from 'react-router/dom';

import BootErrorBoundary from '@/components/BootErrorBoundary';
import NextThemeProvider from '@/layout/GlobalProvider/NextThemeProvider';
import { resolveAppBasename } from '@/spa/appBasename';
import { createSPABrowserRouter, createSPARoot } from '@/spa/runtime';

import { shareRoutes } from './router';

// A tenant share link is `/orgs/{slug}/share/...`; without the basename it falls to
// the catch-all, which leaves the share for the root entry (signin / finder).
const { basename } = resolveAppBasename({
  debugProxy: window.__DEBUG_PROXY__,
  pathname: window.location.pathname,
  tenant: getTenant(),
});
const router = createSPABrowserRouter(shareRoutes, { basename });

createSPARoot(document.getElementById('root')!).render(
  <BootErrorBoundary>
    <NextThemeProvider>
      <RouterProvider router={router} />
    </NextThemeProvider>
  </BootErrorBoundary>,
);
