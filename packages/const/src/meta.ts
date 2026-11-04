import {
  AGENT_AVATAR_GALLERY,
  BRANDING_INBOX_TITLE,
  BRANDING_LOGO_URL,
  BRANDING_USER_AVATAR_URL,
} from '@lobechat/business-const';
import type { MetaData } from '@lobechat/types';

// A distribution with its own avatar gallery supplies the fallback from it, so
// an agent without an avatar still belongs to the same set as the rest.
export const DEFAULT_AVATAR = AGENT_AVATAR_GALLERY?.defaultAvatar ?? '/avatars/agent-default.png';
/**
 * The avatar of a person who has not set one, when the distribution brands it.
 * Every surface that draws a person falls back to it, so someone without a photo
 * looks the same in a Channel, a comment and the user menu. Upstream has none:
 * each surface keeps its own fallback (the emoji below, or initials).
 */
export const BRANDED_USER_AVATAR: string | undefined = BRANDING_USER_AVATAR_URL || undefined;
export const DEFAULT_USER_AVATAR = BRANDED_USER_AVATAR || '😀';
export const DEFAULT_SUPERVISOR_AVATAR = '🎙️';
export const DEFAULT_SUPERVISOR_ID = 'supervisor';
export const DEFAULT_BACKGROUND_COLOR = undefined;
export const DEFAULT_AGENT_META: MetaData = {};
export const DEFAULT_INBOX_TITLE = BRANDING_INBOX_TITLE;
export const DEFAULT_INBOX_AVATAR =
  AGENT_AVATAR_GALLERY?.builtinAvatars?.inbox || BRANDING_LOGO_URL || '/avatars/lobe-ai.png';
export const DEFAULT_USER_AVATAR_URL =
  BRANDED_USER_AVATAR || BRANDING_LOGO_URL || '/app-icons/icon-192x192.png';

/**
 * Avatars for the remaining built-in agents.
 *
 * `/avatars/*.png` are drawings of the LobeHub mascot, and the agents that use
 * them referenced those paths as literals — so they kept the upstream character
 * on a distribution that had rebranded everything else, including the agents
 * sitting next to them in the same picker. Routing them through the same slot as
 * DEFAULT_INBOX_AVATAR is what makes the branding complete rather than partial.
 *
 * Upstream is unaffected: BRANDING_LOGO_URL is empty there, so the fallback
 * keeps each agent's own artwork.
 */
export const DEFAULT_AGENT_BUILDER_AVATAR =
  AGENT_AVATAR_GALLERY?.builtinAvatars?.agentBuilder ||
  BRANDING_LOGO_URL ||
  '/avatars/agent-builder.png';
export const DEFAULT_PAGE_AGENT_AVATAR = BRANDING_LOGO_URL || '/avatars/doc-copilot.png';
