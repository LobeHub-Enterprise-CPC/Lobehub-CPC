/**
 * @vitest-environment node
 */
import { BRANDING_NAME } from '@lobechat/business-const';
import { isCustomBranding } from '@lobechat/const';
import { describe, expect, it } from 'vitest';

import { getEmailBrandHeaderHtml } from '@/libs/email/brandHeader';
import { getEmailSupportHtml, getEmailSupportText } from '@/libs/email/support';

import {
  getChangeEmailVerificationTemplate,
  getMagicLinkEmailTemplate,
  getResetPasswordEmailTemplate,
  getVerificationEmailTemplate,
  getVerificationOTPEmailTemplate,
  getWorkspaceInviteEmailTemplate,
  getWorkspaceMemberRemovedEmailTemplate,
} from './index';

const templates = [
  getChangeEmailVerificationTemplate({
    expiresInSeconds: 3600,
    url: 'https://example.com/change-email',
  }),
  getMagicLinkEmailTemplate({
    expiresInSeconds: 600,
    url: 'https://example.com/sign-in',
  }),
  getResetPasswordEmailTemplate({ url: 'https://example.com/reset-password' }),
  getVerificationEmailTemplate({
    expiresInSeconds: 3600,
    url: 'https://example.com/verify-email',
  }),
  getVerificationOTPEmailTemplate({ expiresInSeconds: 600, otp: '123456' }),
  getWorkspaceInviteEmailTemplate({
    expiresInDays: 7,
    role: 'member',
    url: 'https://example.com/invite',
    workspaceName: 'Example Workspace',
  }),
  getWorkspaceMemberRemovedEmailTemplate({
    reason: 'removed_by_owner',
    workspaceName: 'Example Workspace',
  }),
];

describe('email templates', () => {
  // Support channels and the brand come from the deployment's branding slots; a
  // white-label build may have no support mailbox or community server at all.
  it.each(templates)('carries the branded name and support channels', (template) => {
    expect(template.html).toContain(BRANDING_NAME);
    expect(template.html).toContain(getEmailBrandHeaderHtml());
    // The emoji is upstream's mark; a rebranded deployment must never mail it.
    if (isCustomBranding) expect(template.html).not.toContain('🤯');
    expect(template.html).toContain(getEmailSupportHtml());
    expect(template.text).toContain(getEmailSupportText());
    expect(template.html).not.toMatch(/href="(?:mailto:)?(?:undefined)?"/);
  });
});
