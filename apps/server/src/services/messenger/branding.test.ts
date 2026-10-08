// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { getMessengerSystemStrings } from './systemReply';

vi.mock('@lobechat/business-const', async (original) => ({
  ...(await original<object>()),
  BRANDING_NAME: 'Private Workspace',
}));

describe('private messenger copy', () => {
  it.each(['telegram', 'slack', 'discord', 'wechat'])(
    'brands %s account and help messages',
    (platform) => {
      const strings = getMessengerSystemStrings(platform);
      const text = Object.values(strings)
        .map((v) => (typeof v === 'function' ? (v as any)('Example') : v))
        .join('\n');
      expect(text).toContain('Private Workspace');
      expect(text).not.toMatch(/LobeHub|LobeChat/);
    },
  );
});
