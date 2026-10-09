import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

import { buildTenantPath, parseTenantPath } from '../../../packages/const/src/tenantPath';

// In production the worker inlines this before the document is served. The dev
// server has no such stage, so fetch it through vite's API proxy instead —
// after hydration, which is when `AuthAppShell` first reads it either way. The
// config belongs to the tenant of the page (`/t/{slug}/...`).
const loadDevServerConfig = async () => {
  if (!import.meta.env.DEV) return;

  try {
    const { tenantSlug } = parseTenantPath(window.location.pathname);
    if (!tenantSlug) return;
    const response = await fetch(buildTenantPath('/webapi/auth/spa-config', tenantSlug));
    if (response.ok) window.__SERVER_CONFIG__ = await response.json();
  } catch {
    // Rendering config-less is the same state a failed lookup gives in production.
  }
};

void loadDevServerConfig();

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
