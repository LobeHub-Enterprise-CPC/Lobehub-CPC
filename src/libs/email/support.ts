import { BRANDING_EMAIL, SOCIAL_URL } from '@lobechat/business-const';

interface EmailSupportCopy {
  contactSupport?: string;
  joinDiscord?: string;
}

const DEFAULT_SUPPORT_COPY = {
  contactSupport: 'Contact support',
  joinDiscord: 'Join Discord',
} satisfies Required<EmailSupportCopy>;

export const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

// Branding slots are optional, and a white-label deployment may legitimately
// have no support mailbox or no community server. Both are normalised to
// undefined here — an override that blanks a channel out may use either
// undefined or '' — so the footer builders can drop the channel instead of
// emitting `mailto:undefined` or an empty href into outgoing mail.
export const EMAIL_SUPPORT_ADDRESS: string | undefined = BRANDING_EMAIL.support || undefined;
export const EMAIL_SUPPORT_REPLY_TO: string | undefined = BRANDING_EMAIL.replyTo || undefined;

const DISCORD_URL: string | undefined = SOCIAL_URL.discord || undefined;

const HTML_SEPARATOR = '<span style="color: #a1a1aa;"> · </span>';

export const getEmailSupportHtml = ({
  contactSupport = DEFAULT_SUPPORT_COPY.contactSupport,
  joinDiscord = DEFAULT_SUPPORT_COPY.joinDiscord,
}: EmailSupportCopy = {}) => {
  const links: string[] = [];

  if (EMAIL_SUPPORT_ADDRESS)
    links.push(
      `<a href="mailto:${escapeHtml(EMAIL_SUPPORT_ADDRESS)}" style="color: #6b7280; text-decoration: underline;">${escapeHtml(contactSupport)}</a>`,
    );

  if (DISCORD_URL)
    links.push(
      `<a href="${escapeHtml(DISCORD_URL)}" target="_blank" rel="noopener noreferrer" style="color: #6b7280; text-decoration: underline;">${escapeHtml(joinDiscord)}</a>`,
    );

  return links.join(HTML_SEPARATOR);
};

export const getEmailSupportText = ({
  contactSupport = DEFAULT_SUPPORT_COPY.contactSupport,
  joinDiscord = DEFAULT_SUPPORT_COPY.joinDiscord,
}: EmailSupportCopy = {}) =>
  [
    EMAIL_SUPPORT_ADDRESS && `${contactSupport}: ${EMAIL_SUPPORT_ADDRESS}`,
    DISCORD_URL && `${joinDiscord}: ${DISCORD_URL}`,
  ]
    .filter(Boolean)
    .join(' | ');
