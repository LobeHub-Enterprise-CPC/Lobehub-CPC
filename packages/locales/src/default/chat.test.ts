import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';

import enUS from '../../../../locales/en-US/chat.json';
import zhCN from '../../../../locales/zh-CN/chat.json';
import chat from './chat';
import errorNs from './error';
import pageShareNs from './pageShare';

describe('share page disclaimer', () => {
  it.each([
    [
      'default',
      chat,
      "Shared by a user. The content reflects their views, not Acme Workspace's, and Acme Workspace takes no responsibility for it.",
    ],
    [
      'en-US',
      enUS,
      "Shared by a user. The content reflects their views, not Acme Workspace's, and Acme Workspace takes no responsibility for it.",
    ],
    [
      'zh-CN',
      zhCN,
      '由用户分享，仅代表其个人观点，不代表 Acme Workspace 立场；Acme Workspace 不对该内容承担责任。',
    ],
  ])('uses the configured brand in both clauses (%s)', async (_, resources, expected) => {
    const i18n = createInstance();
    await i18n.init({ lng: 'en', resources: { en: { chat: resources } } });

    expect(i18n.t('chat:sharePageDisclaimer', { appName: 'Acme Workspace' })).toBe(expected);
    expect(i18n.t('chat:sharePageDisclaimer', { appName: 'LobeHub' })).toBe(
      expected.replaceAll('Acme Workspace', 'LobeHub'),
    );
  });
});

// The standalone share SPA loads only these namespaces (see createShareI18n) and
// never registers the brand post-processor, so a shipped translation that drops
// the {{appName}} placeholder leaks the upstream brand verbatim — as the stale
// generated-locale sharePageDisclaimer did. Missing keys are fine: they fall
// back to en-US, which is already branded.
const SHARE_NAMESPACES: Record<string, Record<string, string>> = {
  chat,
  error: errorNs,
  pageShare: pageShareNs,
};

describe('share-loaded namespaces', () => {
  it('keeps the appName placeholder in every shipped locale', () => {
    const root = new URL('../../../../locales/', import.meta.url);
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
