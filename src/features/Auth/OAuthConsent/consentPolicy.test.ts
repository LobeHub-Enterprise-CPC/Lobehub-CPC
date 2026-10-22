import { describe, expect, it } from 'vitest';

import { DESKTOP_CLIENT_ID } from '../desktopAuth';
import { isAutoApprovedClient } from './consentPolicy';

describe('isAutoApprovedClient', () => {
  it('shows the consent page to the desktop client instead of approving silently', () => {
    expect(isAutoApprovedClient(DESKTOP_CLIENT_ID)).toBe(false);
  });

  it('keeps approving the mobile and market clients on the user’s behalf', () => {
    expect(isAutoApprovedClient('lobehub-mobile')).toBe(true);
    expect(isAutoApprovedClient('lobehub-market')).toBe(true);
  });

  it('leaves third-party clients to the consent page', () => {
    expect(isAutoApprovedClient('some-third-party')).toBe(false);
  });
});
