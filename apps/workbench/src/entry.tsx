// Tenant fetch/asset prefixing (`/orgs/{slug}`) and the StyleX sheet, like the main SPA.
import '@/initialize';
import '@/spa/initialize';

import { getTenant } from '@lobechat/business-tenant/client';
import { RouterProvider } from 'react-router/dom';

import BootErrorBoundary from '@/components/BootErrorBoundary';
import NextThemeProvider from '@/layout/GlobalProvider/NextThemeProvider';
import { setReplicaScopeSource } from '@/libs/replica';
import { resolveAppBasename } from '@/spa/appBasename';
import { createSPABrowserRouter, createSPARoot } from '@/spa/runtime';

import { workbenchRoutes } from './router';
import { workbenchReplicaScope } from './shell/workbenchReplicaScope';

// The Workbench runtime never mounts the user store, so the main SPA's scope
// would stay the last-known user's partition with nothing to verify it. Its own
// source keeps public surfaces network-only and lets a private route opt into
// hydrate-then-verify by running the session check (`enableWorkbenchIdentity`).
setReplicaScopeSource(workbenchReplicaScope);

const { basename } = resolveAppBasename({
  debugProxy: window.__DEBUG_PROXY__,
  pathname: window.location.pathname,
  tenant: getTenant(),
});
const router = createSPABrowserRouter(workbenchRoutes, { basename });

createSPARoot(document.getElementById('root')!).render(
  <BootErrorBoundary>
    <NextThemeProvider>
      <RouterProvider router={router} />
    </NextThemeProvider>
  </BootErrorBoundary>,
);
