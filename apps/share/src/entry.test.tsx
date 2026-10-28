import { createBrowserRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

const { capture, render } = vi.hoisted(() => ({ capture: vi.fn(), render: vi.fn() }));
vi.mock('@/initialize', async () => {
  const { initializeTenant } = await import('@lobechat/business-tenant/client');
  initializeTenant(new URL(window.location.href));
  return {};
});
vi.mock('@/components/BootErrorBoundary', () => ({ default: () => null }));
vi.mock('@/layout/GlobalProvider/NextThemeProvider', () => ({ default: () => null }));
vi.mock('./router', () => ({ shareRoutes: [{ path: '/share/t/:id', element: null }] }));
vi.mock('@/spa/runtime', () => ({
  createSPARoot: () => ({ render }),
  createSPABrowserRouter: (...args: Parameters<typeof createBrowserRouter>) => {
    const router = createBrowserRouter(...args);
    capture(router);
    return router;
  },
}));
afterEach(() => {
  capture.mock.calls.forEach(([router]) => router.dispose());
  vi.clearAllMocks();
  vi.resetModules();
});
it('mounts the share entry under the tenant prefix instead of exiting the share', async () => {
  window.history.replaceState(null, '', '/orgs/acme/share/t/abc');
  document.body.innerHTML = '<div id="root"></div>';
  await import('./entry');
  const router = capture.mock.calls[0][0];
  expect(router.state.errors).toBeNull();
  expect(router.basename).toBe('/orgs/acme');
  expect(router.state.matches.at(-1).route.path).toBe('/share/t/:id');
  expect(render).toHaveBeenCalledOnce();
});
