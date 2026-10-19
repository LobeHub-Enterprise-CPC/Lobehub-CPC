import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { resolveTenantlessRoute } from '@/libs/next/proxy/tenantRouting';

/**
 * Every backend route handler must run inside its tenant (`withTenantRequest`), or be one of the
 * deployment-level surfaces the request proxy serves without a tenant. A new handler that is
 * forgotten fails here instead of failing with `TENANT_REQUIRED` for every organization.
 */

/** Route file (relative to this directory) -> a request path the proxy serves without a tenant. */
const TENANTLESS_ROUTES: Record<string, string> = {
  'api/cron/[[...route]]/route.ts': '/api/cron/schedule',
  'api/internal/control-plane/[[...route]]/route.ts': '/api/internal/control-plane/events',
  'api/internal/gateway/[[...route]]/route.ts': '/api/internal/gateway/admission',
  'api/tenant-discovery/desktop-handoff/route.ts': '/api/tenant-discovery/desktop-handoff',
  'api/tenant-discovery/route.ts': '/api/tenant-discovery',
  'api/tenant-discovery/select/route.ts': '/api/tenant-discovery/select',
  'api/version/route.ts': '/api/version',
};

/** A CORS preflight (OPTIONS) is credential-less and may be answered outside a tenant. */
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

const root = __dirname;

const routeFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(file);
    return /^route\.tsx?$/.test(entry.name) ? [file] : [];
  });

const files = routeFiles(root).map((file) => ({
  key: path.relative(root, file).split(path.sep).join('/'),
  source: readFileSync(file, 'utf8'),
}));

const isWrapperCall = (node: ts.Node) =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === 'withTenantRequest';

/** Whether `node` is, or calls through, a `withTenantRequest(...)` wrapper or a binding of one. */
const isWrapped = (node: ts.Node, wrapped: ReadonlySet<string>): boolean =>
  isWrapperCall(node) ||
  (ts.isIdentifier(node) && wrapped.has(node.text)) ||
  ts.forEachChild(node, (child) => (isWrapped(child, wrapped) ? true : undefined)) === true;

/** Exported HTTP handlers of a route module, with whether each one runs inside a tenant. */
const handlersOf = (source: string) => {
  const file = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true);
  const initializers = new Map<string, ts.Expression>();
  const wrapped = new Set<string>();
  const exported: Array<{ name: string; value: ts.Node }> = [];

  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isExport = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    for (const { initializer, name } of statement.declarationList.declarations) {
      if (!ts.isIdentifier(name) || !initializer) continue;
      initializers.set(name.text, initializer);
      if (isWrapped(initializer, wrapped)) wrapped.add(name.text);
      if (isExport) exported.push({ name: name.text, value: initializer });
    }
  }
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const { name, propertyName } of statement.exportClause.elements) {
      const local = (propertyName ?? name).text;
      exported.push({ name: name.text, value: initializers.get(local) ?? name });
    }
  }
  for (const statement of file.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      exported.push({ name: statement.name.text, value: statement });
  }

  return exported
    .filter(({ name }) => METHODS.includes(name))
    .map(({ name, value }) => ({ name, wrapped: isWrapped(value, wrapped) }));
};

describe('backend routes run inside a tenant', () => {
  it('finds the route handlers', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(files.filter(({ key }) => !(key in TENANTLESS_ROUTES)))(
    '$key wraps every handler in withTenantRequest',
    ({ source }) => {
      const handlers = handlersOf(source);
      expect(handlers.length).toBeGreaterThan(0);
      for (const handler of handlers)
        expect(handler.wrapped, `${handler.name} must be wrapped in withTenantRequest`).toBe(true);
    },
  );

  it.each(Object.entries(TENANTLESS_ROUTES))(
    'tenantless route %s is served without a tenant by the proxy',
    (key, path) => {
      expect(files.map((file) => file.key)).toContain(key);
      expect(resolveTenantlessRoute(path).kind).toBe('tenantless-backend');
    },
  );
});
