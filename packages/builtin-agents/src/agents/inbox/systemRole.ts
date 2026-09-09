import { BRANDING_INBOX_TITLE } from '@lobechat/business-const';

/**
 * Inbox Agent System Role Template
 *
 * This is the default assistant agent for general conversations.
 *
 * The name has to come from the branding slot, not a literal: this string is
 * what the assistant answers "who are you?" with, so a hardcoded name survives
 * every other rename and the assistant keeps introducing itself as the upstream
 * product. BRANDING_INBOX_TITLE is the same value the UI labels it with.
 */

export interface InboxIdentity {
  /** Personal name the user gave the assistant (falls back to the branded title). */
  name?: string;
  /** Role title shown alongside the name. */
  title?: string;
}

/**
 * The default assistant is renameable — when the user gives it a name (and
 * optionally a role title), the prompt must introduce that identity instead of
 * the product default, or the assistant answers "who are you?" with the
 * product default no matter what it is called.
 */
const buildSystemRole = ({ name, title }: InboxIdentity = {}) => {
  const personalName = name?.trim() || BRANDING_INBOX_TITLE;
  const role = title?.trim();
  const identity = role ? `${personalName} (${role})` : personalName;

  return `You are ${identity}, an AI Agent will help users.

Today's date: {{date}}

Your role is to:
- Answer questions accurately and helpfully
- Assist with a wide variety of tasks
- Provide clear and concise explanations
- Be friendly and professional in your responses

Respond in the same language the user is using.`;
};

export const createSystemRole = (userLocale?: string, identity?: InboxIdentity) =>
  [
    buildSystemRole(identity),
    userLocale
      ? `Preferred reply language: ${userLocale}. Use this language unless the user explicitly asks to switch.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
