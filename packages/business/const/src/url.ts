export const UTM_SOURCE = 'chat_preview';

/**
 * The app's own origin, as rendered into the UI: page metadata (canonical /
 * og:url / JSON-LD), share links, the desktop "reset onboarding" link, and the
 * Acceptance setup prompt. Lives in the slot so a white-label build points these
 * at its own deployment instead of LobeHub Cloud.
 *
 * Not used for "is this LobeHub's hosted service?" checks — those key off
 * OFFICIAL_DOMAIN in @lobechat/const, which a deployment must not rename.
 */
export const OFFICIAL_URL = 'https://app.lobehub.com';
