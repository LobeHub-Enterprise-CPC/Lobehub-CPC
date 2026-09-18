// the code below can only be modified with commercial license
// if you want to use it in the commercial usage
// please contact us for more information: hello@lobehub.com

export const LOBE_CHAT_CLOUD = 'LobeHub Cloud';

export const BRANDING_NAME = 'LobeHub';
// Override to preserve an installed PWA identity independently of its display name.
// An empty value retains the default derived from BRANDING_NAME.
export const BRANDING_PWA_ID = '';
// White-label distributions supply their logo through the business package override.
export const BRANDING_LOGO_URL = '';

/**
 * Display name of the built-in default assistant (the inbox agent).
 *
 * Kept separate from `BRANDING_NAME` because it reads as a persona, not a
 * product: white-label deployments usually want something like
 * `'<Brand> AI'` rather than the bare product name. Drives
 * `DEFAULT_INBOX_TITLE` and the i18n brand post-processor, so overriding this
 * one constant renames the assistant everywhere.
 */
export const BRANDING_INBOX_TITLE = 'Lobe AI';

// Distributions can override the legal entity independently of the product name.
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
