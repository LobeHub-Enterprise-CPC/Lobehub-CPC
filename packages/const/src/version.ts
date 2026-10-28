import {
  BRANDING_AGENT_TITLE,
  BRANDING_NAME,
  LOBE_CHAT_CLOUD,
  ORG_NAME,
} from '@lobechat/business-const';

// Named, not default: a default JSON import ships the whole manifest —
// repository, bugs and author URLs — into every client bundle.
import { version } from '../../../package.json';
// type-only: loads ./global.d.ts so `__ELECTRON__` exists even when this
// package is compiled from a workspace without the app's ambient declarations
import type {} from './global';

export const CURRENT_VERSION = version;

export const isDesktop = typeof __ELECTRON__ !== 'undefined' && !!__ELECTRON__;

// @ts-ignore
export const isCustomBranding = BRANDING_NAME !== 'LobeHub';
// @ts-ignore
export const isCustomORG = ORG_NAME !== 'LobeHub';

// Re-exported so packages that deliberately do not depend on the business-const
// slot — @lobechat/locales, which only needs the names to rewrite brand strings
// baked into translations — can resolve them through the same adaptation layer
// this package already provides for BRANDING_INBOX_TITLE (see ./meta).
export { BRANDING_AGENT_TITLE, BRANDING_NAME, LOBE_CHAT_CLOUD };
