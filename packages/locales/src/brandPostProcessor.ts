// Imported via @lobechat/const (already a dependency) rather than
// @lobechat/business-const, which this package does not depend on.
import {
  BRANDING_AGENT_TITLE,
  BRANDING_NAME,
  DEFAULT_INBOX_TITLE,
  LOBE_CHAT_CLOUD,
} from '@lobechat/const';
import type { PostProcessorModule } from 'i18next';

/**
 * Upstream brand literals baked into the locale files, each paired with the
 * constant a white-label deployment overrides.
 *
 * Several hundred copy strings name the product or the default assistant inline
 * (`'Ask Lobe AI'`, `'Sign in to LobeHub'`, …) instead of interpolating a brand
 * variable, across ~18 locales. Rewriting the JSON per deployment would touch a
 * thousand tracked files and conflict on every upgrade, so white-label
 * deployments patch the strings as they are translated instead.
 *
 * ORDER MATTERS — entries are matched longest-first, so `LobeHub Cloud` has to
 * come before `LobeHub`, or a deployment that renamed the hosted service could
 * never see its own LOBE_CHAT_CLOUD in translated copy. A deployment that
 * renames only BRANDING_NAME drops the (now identity) Cloud pair and falls
 * through to the shorter rule, yielding `<brand> Cloud` — degraded, but still
 * not a leak.
 *
 * `LobeChat` is the pre-rename product name. It still appears in locales that
 * have not been retranslated since the rename (ja-JP, ko-KR, zh-TW, …), so a
 * deployment that rewrote only `LobeHub` would keep leaking it.
 */
const BRAND_LITERALS: [from: string, to: string][] = [
  // Use the bot display name, without advertising or inventing an account handle.
  ['@LobeHub', (BRANDING_NAME as string) === 'LobeHub' ? '@LobeHub' : BRANDING_NAME],
  ['LobeHub Cloud', LOBE_CHAT_CLOUD],
  ['LobeHub', BRANDING_NAME],
  ['LobeChat', BRANDING_NAME],
  ['Lobe Agent', BRANDING_AGENT_TITLE],
  ['Lobe-Agent', BRANDING_AGENT_TITLE],
  ['Lobe AI', DEFAULT_INBOX_TITLE],
  ['LobeAI', DEFAULT_INBOX_TITLE],
  // Translated compound names and runtime errors also use the bare brand.
  ['Lobe', (BRANDING_NAME as string) === 'LobeHub' ? 'Lobe' : BRANDING_NAME],
];

/** Only the literals this deployment actually renamed; identity pairs are noise. */
const replacements = BRAND_LITERALS.filter(([from, to]) => from !== to);

const lookup = new Map(replacements);

/**
 * Every literal above contains this, which is what makes the pre-filter in
 * applyBrandStrings sound. Kept beside BRAND_LITERALS so the two cannot drift.
 */
const COMMON_PREFIX = 'Lobe';

/**
 * One alternation covering every active literal, rather than a replaceAll pass
 * per entry: this runs on every single t() call, so the work has to stay
 * proportional to the string rather than to the size of the table.
 *
 * The `from` values are the literals defined above — letters, spaces and @ only —
 * so they need no regex escaping.
 *
 * The upstream Slack handle has its own longest-first rule. Private builds
 * refer to the bot by display name without inventing an account handle.
 */
const pattern = replacements.length
  ? new RegExp(
      `(?<!@)(${replacements.map(([from]) => (from === 'Lobe' ? 'Lobe(?![A-Za-z0-9_])' : from)).join('|')})`,
      'g',
    )
  : undefined;

export const isBrandPostProcessorEnabled = replacements.length > 0;

export const BRAND_POST_PROCESSOR = 'brandStrings';

/** Apply the brand rewrites to one translated string. */
export const applyBrandStrings = (value: string): string => {
  // Fast path: the overwhelming majority of translated strings never mention the
  // brand, and one substring scan is much cheaper than running the regex.
  if (!pattern || !value.includes(COMMON_PREFIX)) return value;

  return value.replaceAll(pattern, (match) => lookup.get(match) ?? match);
};

const isRebranded = (BRANDING_NAME as string) !== 'LobeHub';

/** `Acme Work` → `ACME_WORK`: the brand spelled as an environment-variable prefix. */
const BRAND_ENV_PREFIX = BRANDING_NAME.toUpperCase()
  .replaceAll(/[^\dA-Z]+/g, '_')
  .replaceAll(/^_+|_+$/g, '');

/**
 * `Acme Work` → `ACME`: an example task prefix in the brand's name. Must pass
 * PROJECT_IDENTIFIER_REGEX (a letter, then 2–5 letters or digits); a brand too
 * short to yield one falls back to a neutral example.
 */
const BRAND_TASK_PREFIX = (() => {
  const letters = BRANDING_NAME.toUpperCase().replaceAll(/[^\dA-Z]/g, '');
  return /^[A-Z][\dA-Z]{2}/.test(letters) ? letters.slice(0, 4) : 'PROJ';
})();

/**
 * Upper-case upstream tokens that the name rewrite cannot see, scoped to the
 * copy that carries them so an identically spelled real identifier elsewhere
 * is never touched:
 *
 * - The OAuth app "integration prompt" tells a coding agent to read the client
 *   secret from `LOBEHUB_CLIENT_SECRET`. Nothing reads that variable — it is a
 *   name the user's own project adopts — so it follows the brand.
 * - The project form gives `LOBE` / `LOBE-123` as the example task prefix.
 */
const rewriteKeyedTokens = (value: string, keys: string[]): string => {
  if (keys.some((key) => key.startsWith('oauthApp.integration.prompt')))
    return value.replaceAll('LOBEHUB_CLIENT_SECRET', `${BRAND_ENV_PREFIX}_CLIENT_SECRET`);
  if (keys.some((key) => /(?:^|\.)create\.identifier(?:Placeholder|Description)$/.test(key)))
    return value.replaceAll(/\bLOBE\b/g, BRAND_TASK_PREFIX);
  return value;
};

/**
 * Rewrite hardcoded brand strings in translated copy so white-label
 * deployments never surface the upstream product's names. A no-op (and never
 * registered) under default branding.
 */
export const brandPostProcessor: PostProcessorModule = {
  name: BRAND_POST_PROCESSOR,
  process: (value, keys) => {
    if (typeof value !== 'string') return value;
    const keyList = Array.isArray(keys) ? keys : [keys];
    // Keep the capability bundle's proper name identical across locales, even
    // where older translations localized or reordered the words in its title.
    if (
      (BRANDING_AGENT_TITLE as string) !== 'Lobe Agent' &&
      keyList.some((key) => key.endsWith('builtins.lobe-agent.title'))
    )
      return BRANDING_AGENT_TITLE;
    return applyBrandStrings(isRebranded ? rewriteKeyedTokens(value, keyList) : value);
  },
  type: 'postProcessor',
};
