/**
 * @vitest-environment happy-dom
 */
import { initializeTenant } from '@lobechat/business-tenant/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedAttachments } from './attachmentRegistry';
import { getFileDownloadUrl, openFileDownload } from './fileDownload';

// The page the app is served from: its origin and tenant are the default app address.
const openPage = (url: string) => {
  (window as typeof window & { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(url);
  initializeTenant(new URL(url));
};

beforeEach(() => {
  openPage('https://app.lobehub.com/tasks/T-201');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fileDownload', () => {
  it('requests attachment delivery for file proxy URLs', () => {
    expect(
      getFileDownloadUrl('/f/file_123', {
        baseUrl: 'https://app.lobehub.com/tasks/T-201',
      }),
    ).toBe('https://app.lobehub.com/f/file_123?download=1');
  });

  it('keeps unregistered direct storage URLs unchanged', () => {
    const url = 'https://storage.example.com/video.mp4?X-Amz-Signature=signature';

    expect(getFileDownloadUrl(url, { baseUrl: 'https://app.lobehub.com/tasks/T-201' })).toBe(url);
  });

  it('routes direct storage URLs through the stable file download proxy', () => {
    const url = 'https://storage.example.com/video.mp4?X-Amz-Signature=signature';

    expect(
      getFileDownloadUrl(url, {
        downloadUrl: 'https://app.lobehub.com/f/file_video',
        fileId: 'file_video',
      }),
    ).toBe('https://app.lobehub.com/f/file_video?download=1');
  });

  it('opens the download synchronously in a new tab', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    openFileDownload('/f/file_123');

    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('/f/file_123?download=1'),
      '_blank',
      'noopener,noreferrer',
    );
  });

  it('opens historical presigned URLs through the registered download proxy', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    seedAttachments([
      {
        downloadUrl: 'https://app.lobehub.com/f/file_historical',
        id: 'file_historical',
        url: 'https://storage.example.com/tasks/report.pdf?X-Amz-Signature=current',
      },
    ]);

    openFileDownload('https://storage.example.com/tasks/report.pdf?X-Amz-Signature=historical');

    expect(open).toHaveBeenCalledWith(
      'https://app.lobehub.com/f/file_historical?download=1',
      '_blank',
      'noopener,noreferrer',
    );
  });

  describe('under a tenant address', () => {
    it('requests attachment delivery for tenant file proxy URLs', () => {
      openPage('https://app.lobehub.com/t/acme/agent');

      expect(
        getFileDownloadUrl('https://app.lobehub.com/t/acme/f/file_123', {
          baseUrl: 'https://app.lobehub.com/t/acme/tasks/T-201',
        }),
      ).toBe('https://app.lobehub.com/t/acme/f/file_123?download=1');
    });

    it("leaves another tenant's file proxy URL as it is", () => {
      openPage('https://app.lobehub.com/t/acme/agent');

      expect(
        getFileDownloadUrl('https://app.lobehub.com/t/beta/f/file_123', {
          baseUrl: 'https://app.lobehub.com/t/acme/tasks/T-201',
        }),
      ).toBe('https://app.lobehub.com/t/beta/f/file_123');
    });

    it('builds the stable download proxy under the current tenant', () => {
      expect(
        getFileDownloadUrl('https://storage.example.com/video.mp4?sig=1', {
          appUrl: 'https://app.lobehub.com/t/acme',
          fileId: 'file_video',
        }),
      ).toBe('https://app.lobehub.com/t/acme/f/file_video?download=1');
    });
  });

  describe('under a custom-domain entry', () => {
    it('builds the download proxy at the domain root, never under /t/', () => {
      expect(
        getFileDownloadUrl('https://storage.example.com/video.mp4?sig=1', {
          appUrl: 'https://chat.acme.example',
          fileId: 'file_video',
        }),
      ).toBe('https://chat.acme.example/f/file_video?download=1');
    });
  });

  describe('on desktop (the app address is the remote tenant address)', () => {
    const appUrl = 'https://host.example/t/acme';

    it('requests attachment delivery for the tenant file proxy URL the server returned', () => {
      expect(
        getFileDownloadUrl('https://host.example/t/acme/f/file_123', {
          appUrl,
          baseUrl: 'app://desktop/agent',
        }),
      ).toBe('https://host.example/t/acme/f/file_123?download=1');
    });

    it("leaves another tenant's file URL as it is", () => {
      const url = 'https://host.example/t/beta/f/file_123';

      expect(getFileDownloadUrl(url, { appUrl, baseUrl: 'app://desktop/agent' })).toBe(url);
    });

    it('builds the download proxy on the remote tenant address, not the renderer origin', () => {
      expect(
        getFileDownloadUrl('https://storage.example.com/video.mp4?sig=1', {
          appUrl,
          fileId: 'file_video',
        }),
      ).toBe('https://host.example/t/acme/f/file_video?download=1');
    });
  });
});
