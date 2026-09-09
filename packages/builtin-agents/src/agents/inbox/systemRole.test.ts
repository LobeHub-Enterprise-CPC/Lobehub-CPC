import { BRANDING_INBOX_TITLE } from '@lobechat/business-const';
import { describe, expect, it } from 'vitest';

import { createSystemRole } from './systemRole';

describe('inbox createSystemRole', () => {
  // Asserted through the branding slot, not as a literal: the default name is
  // whatever this distribution calls its assistant, and pinning the upstream
  // one here would fail every white-label build for the right reason.
  it('defaults to the branded assistant title when it has no custom name', () => {
    expect(createSystemRole()).toContain(`You are ${BRANDING_INBOX_TITLE}, an AI Agent`);
  });

  it('introduces the user-given name instead of the product default', () => {
    const result = createSystemRole(undefined, { name: '芙莉莲' });

    expect(result).toContain('You are 芙莉莲, an AI Agent');
    expect(result).not.toContain(`You are ${BRANDING_INBOX_TITLE}`);
  });

  it('carries the role title alongside the name', () => {
    expect(createSystemRole(undefined, { name: '芙莉莲', title: '魔法使' })).toContain(
      'You are 芙莉莲 (魔法使), an AI Agent',
    );
  });

  it('uses the title as identity when there is no name', () => {
    expect(createSystemRole(undefined, { title: 'Health Assistant' })).toContain(
      `You are ${BRANDING_INBOX_TITLE} (Health Assistant), an AI Agent`,
    );
  });

  it('treats blank identity values as absent', () => {
    expect(createSystemRole(undefined, { name: '  ', title: '' })).toContain(
      `You are ${BRANDING_INBOX_TITLE}, an AI Agent`,
    );
  });

  it('keeps the preferred-language suffix', () => {
    expect(createSystemRole('zh-CN', { name: '芙莉莲' })).toContain(
      'Preferred reply language: zh-CN',
    );
  });
});
