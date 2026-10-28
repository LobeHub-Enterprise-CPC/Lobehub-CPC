import { createBrowserRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';

const { capture, render } = vi.hoisted(() => ({ capture: vi.fn(), render: vi.fn() }));
vi.mock('@/initialize', async () => {
  const { initializeTenant } = await import('@lobechat/business-tenant/client');
  initializeTenant(new URL(window.location.href));
  return {};
});
vi.mock('@/spa/initialize', () => ({}));
vi.mock('@/libs/replica', () => ({ setReplicaScopeSource: vi.fn() }));
vi.mock('./shell/workbenchReplicaScope', () => ({ workbenchReplicaScope: {} }));
vi.mock('@/components/BootErrorBoundary', () => ({ default: () => null }));
vi.mock('@/layout/GlobalProvider/NextThemeProvider', () => ({ default: () => null }));
vi.mock('./router', () => ({
  workbenchRoutes: [{ path: '/agent/:aid/docs/:docId', element: null }],
}));
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
it('mounts the workbench entry under the tenant prefix', async () => {
  window.history.replaceState(null, '', '/t/acme/agent/agt_1/docs/doc_1');
  document.body.innerHTML = '<div id="root"></div>';
  await import('./entry');
  const router = capture.mock.calls[0][0];
  expect(router.state.errors).toBeNull();
  expect(router.basename).toBe('/t/acme');
  expect(router.state.matches.at(-1).route.path).toBe('/agent/:aid/docs/:docId');
  expect(render).toHaveBeenCalledOnce();
});
