import '../initialize';

import { getTenant } from '@lobechat/business-tenant/client';
import { RouterProvider } from 'react-router/dom';

import BootErrorBoundary from '@/components/BootErrorBoundary';
import NextThemeProvider from '@/layout/GlobalProvider/NextThemeProvider';

import { resolveAppBasename } from './appBasename';
import { authRoutes } from './router/authRouter.config';
import { createSPABrowserRouter, createSPARoot } from './runtime';

const { basename } = resolveAppBasename({
  debugProxy: window.__DEBUG_PROXY__,
  pathname: window.location.pathname,
  tenant: getTenant(),
});
const router = createSPABrowserRouter(authRoutes, { basename });

createSPARoot(document.getElementById('root')!).render(
  <BootErrorBoundary>
    <NextThemeProvider>
      <RouterProvider router={router} />
    </NextThemeProvider>
  </BootErrorBoundary>,
);
