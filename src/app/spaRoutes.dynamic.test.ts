import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every SPA shell route reads the request (the signed tenant route header) to
 * render tenant-specific HTML. Next.js prerenders a route handler that exports
 * `generateStaticParams`, and in a production build the first `request.headers`
 * read then fails with `DYNAMIC_SERVER_USAGE` (HTTP 500). The dev server never
 * prerenders, so only the deployed image showed it. Such shells must be
 * `force-dynamic` and must not declare static params.
 *
 * Source is inspected rather than imported: the route modules lazily import
 * generated HTML templates that only exist after the SPA build.
 */
const appDir = __dirname;

const collectRoutes = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectRoutes(full);
    return entry.name === 'route.ts' ? [full] : [];
  });

const routes = collectRoutes(appDir).map((file) => ({
  file: path.relative(appDir, file),
  source: readFileSync(file, 'utf8'),
}));

const requestBound = routes.filter(({ source }) => /getTenantPageBootstrap/.test(source));

describe('request-bound route handlers render per request', () => {
  it('finds the four SPA shell routes', () => {
    expect(requestBound.map(({ file }) => file).sort()).toEqual([
      'spa-auth/[locale]/[[...path]]/route.ts',
      'spa-share/[locale]/[[...path]]/route.ts',
      'spa-workbench/[locale]/[[...path]]/route.ts',
      'spa/[variants]/[[...path]]/route.ts',
    ]);
  });

  it.each(requestBound.map(({ file, source }) => [file, source]))(
    '%s is force-dynamic',
    (_file, source) => {
      expect(source).toMatch(/^export const dynamic = 'force-dynamic';$/m);
    },
  );

  it.each(requestBound.map(({ file, source }) => [file, source]))(
    '%s declares no generateStaticParams',
    (_file, source) => {
      expect(source).not.toMatch(/generateStaticParams/);
    },
  );
});
