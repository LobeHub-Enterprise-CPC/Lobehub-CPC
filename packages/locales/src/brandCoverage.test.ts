import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { applyBrandStrings, isBrandPostProcessorEnabled } from './brandPostProcessor';

// Upstream bakes the product name into translated copy instead of interpolating a
// brand variable, and `brandPostProcessor` rewrites those literals at `t()` time
// (see ./brandPostProcessor). That only helps a surface whose i18next instance
// actually registers the processor: the standalone SPAs each build their own
// instance, and one that forgets serves the upstream brand verbatim. INC-009
// recorded exactly that for the share disclaimer, where the workaround was a
// per-key `{{appName}}` placeholder plus a consumer that had to remember to pass
// the value.
//
// This asserts the resource half: for every one of the 18 shipped locales, each
// literal in the namespaces those SPAs load is rewritable by the processor, so no
// translation can survive the registration fix. The instance half — that each SPA
// factory registers the processor — is asserted next to those factories
// (`createShareI18n.test.ts`, `createAuthI18n.test.ts`,
// `createWorkbenchI18n.test.ts`), because it needs each app's own test
// environment.
//
// Lives in packages/locales/src/, NOT src/default/: the app bundles every file
// under default/ through the `@/locales/default/*` dynamic-import glob, where
// node:fs and unresolvable `new URL(..., import.meta.url)` fail the Turbopack
// production build.
const SPA_NAMESPACES = ['chat', 'error', 'pageShare', 'verify', 'auth', 'oauth', 'marketAuth'];

const LITERAL = /LobeHub|LobeChat/;

describe('brand literals in SPA-served locales', () => {
  it('stays rewritable in every shipped locale', () => {
    // Under default branding the processor is never registered and the upstream
    // name is correct, so there is nothing to rewrite.
    if (!isBrandPostProcessorEnabled) return;

    const root = new URL('../../../locales/', import.meta.url);
    const failures: string[] = [];
    let literals = 0;

    for (const locale of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const ns of SPA_NAMESPACES) {
        let resources: Record<string, unknown>;
        try {
          resources = JSON.parse(readFileSync(new URL(`${locale.name}/${ns}.json`, root), 'utf8'));
        } catch {
          continue;
        }

        for (const [key, value] of Object.entries(resources)) {
          if (typeof value !== 'string' || !LITERAL.test(value)) continue;
          literals++;
          // If the processor cannot rewrite it, the SPA rendering this locale
          // leaks the upstream brand no matter which instance serves it.
          if (LITERAL.test(applyBrandStrings(value))) failures.push(`${locale.name}/${ns}:${key}`);
        }
      }
    }

    expect(literals).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
