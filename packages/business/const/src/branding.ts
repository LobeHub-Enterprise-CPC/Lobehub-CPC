// the code below can only be modified with commercial license
// if you want to use it in the commercial usage
// please contact us for more information: hello@lobehub.com

export const LOBE_CHAT_CLOUD = 'LobeHub Cloud';

export const BRANDING_NAME = 'TiTu Work';
/**
 * `/branding/logo-head.png` is served from the *submodule's* `public/`
 * directory, not this package — it only exists there at build/dev time,
 * copied in by `scripts/sync-branding.mjs` from the outer repo's
 * `branding/public/branding/` (gitignored inside the submodule, so the
 * customer's logo file itself never lands in this git history). Left empty
 * this always 404s; every consumer already falls back to a bundled default
 * when this is falsy, so an empty string was "safe" but wrong — it kept
 * showing lobehub's own default avatars instead of the customer's mascot.
 */
export const BRANDING_LOGO_URL = '/branding/logo-head.png';

/**
 * Display name of the built-in default assistant (the inbox agent).
 *
 * Kept separate from `BRANDING_NAME` because it reads as a persona, not a
 * product: white-label deployments usually want something like
 * `'<Brand> AI'` rather than the bare product name. Drives
 * `DEFAULT_INBOX_TITLE` and the i18n brand post-processor, so overriding this
 * one constant renames the assistant everywhere.
 */
export const BRANDING_INBOX_TITLE = 'TiTu Work AI';

/**
 * No graceful "unset" exists for this one — `COPYRIGHT`/`COPYRIGHT_FULL`
 * always render *some* org name — so this defaults to `BRANDING_NAME` rather
 * than staying `'LobeHub'`. Replace with the real legal entity name once
 * known; until then this is a placeholder, not a considered choice.
 */
export const ORG_NAME = BRANDING_NAME;

// Left unset on purpose: no confirmed enterprise help/privacy/terms pages or
// hosted-subscription plan yet. `withLinks`-style filtering (see About.tsx)
// already drops any UI item built from an unset field here.
export const BRANDING_URL = {
  help: undefined,
  privacy: undefined,
  subscription: undefined,
  support: undefined,
  terms: undefined,
};

// Left unset on purpose: no enterprise-owned Discord/GitHub/social presence
// yet. Every call site either drops the link when falsy (About.tsx's
// `withLinks`) or renders a no-op `href={undefined}` anchor.
export const SOCIAL_URL = {
  discord: undefined,
  github: undefined,
  medium: undefined,
  x: undefined,
  youtube: undefined,
};

export const FILE_URL = {
  importFromNotionGuide: 'https://hub-apac-1.lobeobjects.space/assets/notion.mp4',
};

// Left unset on purpose: no confirmed enterprise support/business mailbox
// yet. `About.tsx` already drops the affected contact items when falsy;
// `FeedbackModal/FeedbackContent.tsx` was patched alongside this change to
// do the same for its email-contact line.
export const BRANDING_EMAIL = {
  business: undefined,
  replyTo: undefined,
  support: undefined,
};

export const BRANDING_PROVIDER = 'lobehub';

export const APPLE_APP_STORE_ID = '';

export const COPYRIGHT = `© ${new Date().getFullYear()} ${ORG_NAME}`;
export const COPYRIGHT_FULL = `${COPYRIGHT}. All rights reserved.`;
