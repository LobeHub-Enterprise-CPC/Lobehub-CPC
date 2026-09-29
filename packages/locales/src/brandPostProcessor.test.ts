import { readdirSync, readFileSync } from 'node:fs';

import { BRANDING_NAME, DEFAULT_INBOX_TITLE, LOBE_CHAT_CLOUD } from '@lobechat/const';
import i18next from 'i18next';
import { describe, expect, it, vi } from 'vitest';

import {
  applyBrandStrings,
  brandPostProcessor,
  isBrandPostProcessorEnabled,
} from './brandPostProcessor';

vi.mock('@lobechat/const', () => ({
  BRANDING_AGENT_TITLE: 'Acme Agent',
  BRANDING_NAME: 'Acme Workspace',
  DEFAULT_INBOX_TITLE: 'Acme Assistant',
  LOBE_CHAT_CLOUD: 'Acme Workspace Cloud',
}));

// Exercise the deployment's distinct product, assistant and capability names.
describe('applyBrandStrings', () => {
  it('brands the skill title and description, including Traditional Chinese copy', () => {
    expect(applyBrandStrings('Lobe Agent')).toBe('Acme Agent');
    expect(applyBrandStrings('內建 Lobe Agent 功能：計劃和待辦事項管理')).toBe(
      '內建 Acme Agent 功能：計劃和待辦事項管理',
    );
  });

  it('brands the compact assistant spelling used by skill and workspace screens', () => {
    expect(applyBrandStrings('Use in LobeAI')).toBe('Use in Acme Assistant');
  });

  it('preserves technical identifiers, package names and URLs', () => {
    const value = 'lobe-agent @lobehub/ui https://lobehub.com';
    expect(applyBrandStrings(value)).toBe(value);
  });

  it('rewrites the upstream assistant name to the deployment default', () => {
    expect(applyBrandStrings('Ask Lobe AI')).toBe(`Ask ${DEFAULT_INBOX_TITLE}`);
  });

  it('rewrites the upstream product name to the deployment brand', () => {
    expect(applyBrandStrings('Sign in to LobeHub')).toBe(`Sign in to ${BRANDING_NAME}`);
  });

  it('rewrites the pre-rename product name, still present in stale translations', () => {
    expect(applyBrandStrings('LobeChat supports custom API keys')).toBe(
      `${BRANDING_NAME} supports custom API keys`,
    );
  });

  it('prefers the hosted-service name over the bare product name', () => {
    // Longest-first ordering: matching 'LobeHub' first would leave a dangling
    // ' Cloud' and make LOBE_CHAT_CLOUD unreachable from translated copy.
    //
    // A deployment may rename the product but leave the hosted service at the
    // upstream value; the Cloud pair is then an identity and gets dropped, so
    // the shorter rule takes over and produces '<brand> Cloud'. Degraded, but
    // still not a leak — assert that documented fallback rather than failing on
    // a legitimate config.
    const cloudRenamed = (LOBE_CHAT_CLOUD as string) !== 'LobeHub Cloud';
    const brandRenamed = (BRANDING_NAME as string) !== 'LobeHub';
    const expected = !cloudRenamed && brandRenamed ? `${BRANDING_NAME} Cloud` : LOBE_CHAT_CLOUD;

    expect(applyBrandStrings('or just use LobeHub Cloud')).toBe(`or just use ${expected}`);
  });

  it('rewrites every occurrence in one string', () => {
    expect(applyBrandStrings('Lobe AI and Lobe AI')).toBe(
      `${DEFAULT_INBOX_TITLE} and ${DEFAULT_INBOX_TITLE}`,
    );
  });

  it('does not advertise upstream handles or invent replacement handles', () => {
    // '@LobeHub' is a Slack account that only exists under the upstream brand;
    // rewriting it would hand the user an address that does not resolve.
    expect(applyBrandStrings('DM @LobeHub on Slack to link your account')).toBe(
      `DM ${(BRANDING_NAME as string) === 'LobeHub' ? '@LobeHub' : BRANDING_NAME} on Slack to link your account`,
    );
  });

  it('leaves unrelated copy untouched', () => {
    expect(applyBrandStrings('Start a new topic')).toBe('Start a new topic');
    expect(applyBrandStrings('Lobelia LobeAgentIdentifier')).toBe('Lobelia LobeAgentIdentifier');
  });

  it('brands bare and translated compound names without changing surrounding copy', () => {
    expect(applyBrandStrings('Lobe言語モデル / Lobe Style / Lobe-Agent')).toBe(
      'Acme Workspace言語モデル / Acme Workspace Style / Acme Agent',
    );
  });

  it('is enabled exactly when at least one rewrite pair is non-identity', () => {
    // Cast away the literal types: under a given branding config tsc knows the
    // outcome of these comparisons, but the assertion must hold for both.
    // 'LobeChat' → BRANDING_NAME is a real rewrite even under default branding
    // ('LobeChat' !== 'LobeHub'), so enabled is not the same as "the deployment
    // renamed something" — it only means some pair in BRAND_LITERALS differs.
    const anyNonIdentityPair =
      (LOBE_CHAT_CLOUD as string) !== 'LobeHub Cloud' ||
      (BRANDING_NAME as string) !== 'LobeHub' ||
      (BRANDING_NAME as string) !== 'LobeChat' ||
      (DEFAULT_INBOX_TITLE as string) !== 'Lobe AI';

    expect(isBrandPostProcessorEnabled).toBe(anyNonIdentityPair);
  });
});

describe('brandPostProcessor', () => {
  it.each([
    { keys: 'builtins.lobe-agent.title' },
    { keys: ['unrelated', 'builtins.lobe-agent.title'] },
  ])('resolves the capability title for key $keys', ({ keys }) => {
    expect(brandPostProcessor.process('能力名称', keys, {}, {} as never)).toBe('Acme Agent');
  });

  it('rewrites ordinary copy when i18next supplies a single key', () => {
    expect(brandPostProcessor.process('Ask Lobe AI', 'greeting', {}, {} as never)).toBe(
      'Ask Acme Assistant',
    );
  });

  it('brands shipped locale text and resolves the exact skill name through i18next', async () => {
    const root = new URL('../../../locales/', import.meta.url);
    const instance = i18next.createInstance().use(brandPostProcessor);
    await instance.init({
      fallbackLng: false,
      keySeparator: false,
      lng: 'en-US',
      postProcess: ['brandStrings'],
    });

    for (const locale of readdirSync(root, { withFileTypes: true }).filter((dir) =>
      dir.isDirectory(),
    )) {
      for (const file of readdirSync(new URL(`${locale.name}/`, root)).filter((file) =>
        file.endsWith('.json'),
      )) {
        const resources = JSON.parse(readFileSync(new URL(`${locale.name}/${file}`, root), 'utf8'));
        const ns = file.slice(0, -5);
        instance.addResourceBundle(locale.name, ns, resources);
        for (const [key, value] of Object.entries(resources)) {
          if (typeof value !== 'string' || !value.includes('Lobe')) continue;
          const translated = instance.t(`${ns}:${key}`, value, { lng: locale.name });
          expect(translated, `${locale.name}/${ns}:${key}`).not.toContain('Lobe');
          if (key.endsWith('builtins.lobe-agent.title')) expect(translated).toBe('Acme Agent');
        }
      }
    }
  });

  it('passes non-string values through untouched', () => {
    const value = { count: 1 };
    expect(brandPostProcessor.process(value as never, ['key'], {}, {} as never)).toBe(value);
  });
});
