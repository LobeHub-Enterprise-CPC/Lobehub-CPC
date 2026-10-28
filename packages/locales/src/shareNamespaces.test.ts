import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import chat from './default/chat';
import errorNs from './default/error';
import pageShareNs from './default/pageShare';

// The standalone share SPA loads only these namespaces (see createShareI18n)
// and never registers the brand post-processor, so a shipped translation that
// drops the {{appName}} placeholder leaks the upstream brand verbatim — as the
// stale generated-locale sharePageDisclaimer did. Missing keys are fine: they
// fall back to en-US, which is already branded.
//
// This file lives in src/, not src/default/: the app bundles every file under
// default/ through the `@/locales/default/*` dynamic-import glob, where
// node:fs and unresolvable `new URL(..., import.meta.url)` expressions fail
// the Turbopack production build.
const SHARE_NAMESPACES: Record<string, Record<string, string>> = {
  chat,
  error: errorNs,
  pageShare: pageShareNs,
};

describe('share-loaded namespaces', () => {
  it('keeps the appName placeholder in every shipped locale', () => {
    const root = new URL('../../../locales/', import.meta.url);
    const failures: string[] = [];

    for (const locale of readdirSync(root, { withFileTypes: true }).filter((dir) =>
      dir.isDirectory(),
    )) {
      for (const [ns, source] of Object.entries(SHARE_NAMESPACES)) {
        const file = new URL(`${locale.name}/${ns}.json`, root);
        if (!existsSync(file)) continue;

        const resources: Record<string, unknown> = JSON.parse(readFileSync(file, 'utf8'));

        for (const [key, sourceValue] of Object.entries(source)) {
          if (!sourceValue.includes('{{appName}}')) continue;
          const value = resources[key];
          if (typeof value === 'string' && !value.includes('{{appName}}'))
            failures.push(`${locale.name}/${ns}:${key}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
