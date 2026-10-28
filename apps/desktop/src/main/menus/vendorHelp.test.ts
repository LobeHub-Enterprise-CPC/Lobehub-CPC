import { DOWNLOAD_URL } from '@lobechat/const/url';
import { describe, expect, it } from 'vitest';

import { updateDownloadUrl, vendorHelpItems } from './vendorHelp';

describe('vendorHelpItems', () => {
  it('keeps the vendor entries and their closing separator on the vendor build', () => {
    expect(vendorHelpItems([{ label: 'Website' }], false)).toEqual([
      { label: 'Website' },
      { type: 'separator' },
    ]);
  });

  it('drops them entirely on a rebranded build', () => {
    expect(vendorHelpItems([{ label: 'Website' }], true)).toEqual([]);
  });
});

describe('updateDownloadUrl', () => {
  it('sends a rebranded build to the server it was packaged for', () => {
    expect(updateDownloadUrl(true, 'https://app.example.com')).toBe('https://app.example.com');
  });

  it('keeps the upstream downloads page on the vendor build, or without a server', () => {
    expect(updateDownloadUrl(false, 'https://app.example.com')).toBe(DOWNLOAD_URL.default);
    expect(updateDownloadUrl(true, '')).toBe(DOWNLOAD_URL.default);
  });
});
