/** @vitest-environment node */
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { describe, expect, it, vi } from 'vitest';

import { config } from './proxy';

vi.mock('@/libs/next/proxy/define-config', () => ({
  defineConfig: () => ({ middleware: vi.fn() }),
}));

describe('SPA proxy route matching', () => {
  it.each(['/a/shared-agent', '/a/e2e-missing-share', '/a/shared-agent?hl=en-US'])(
    'routes %s through the SPA proxy',
    (pathname) => {
      expect(
        unstable_doesMiddlewareMatch({ config, url: `http://localhost:3010${pathname}` }),
      ).toBe(true);
    },
  );

  // Backend surfaces go through the proxy, the one place that reads the
  // tenant (spec FR-RT-04): a tenant path is rewritten with a signed tenant
  // header, a tenantless one is refused before it reaches a handler.
  it.each([
    '/api/chat',
    '/trpc/lambda/share.getSharedAgent',
    '/webapi/chat',
    '/t/acme/api/workflows/goal/advance',
    '/t/acme/trpc/lambda/share.getSharedAgent',
  ])('routes backend request %s through the proxy', (pathname) => {
    expect(
      unstable_doesMiddlewareMatch({ config, url: `http://localhost:3010${pathname}` }),
    ).toBe(true);
  });
});
