/**
 * @vitest-environment happy-dom
 */
import { initializeTenant } from '@lobechat/business-tenant/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seedAttachments } from './attachmentRegistry';
import { getFileDownloadUrl, openFileDownload } from './fileDownload';

afterEach(() => {
  vi.restoreAllMocks();
  initializeTenant(new URL('https://app.lobehub.com/'));
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
      initializeTenant(new URL('https://app.lobehub.com/t/acme/agent'));

      expect(
        getFileDownloadUrl('https://app.lobehub.com/t/acme/f/file_123', {
          baseUrl: 'https://app.lobehub.com/t/acme/tasks/T-201',
        }),
      ).toBe('https://app.lobehub.com/t/acme/f/file_123?download=1');
    });

    it("leaves another tenant's file proxy URL as it is", () => {
      initializeTenant(new URL('https://app.lobehub.com/t/acme/agent'));

      expect(
        getFileDownloadUrl('https://app.lobehub.com/t/beta/f/file_123', {
          baseUrl: 'https://app.lobehub.com/t/acme/tasks/T-201',
        }),
      ).toBe('https://app.lobehub.com/t/beta/f/file_123');
    });

    it('builds the stable download proxy under the current tenant', () => {
      initializeTenant(new URL('https://app.lobehub.com/t/acme/agent'));

      expect(
        getFileDownloadUrl('https://storage.example.com/video.mp4?sig=1', {
          appOrigin: 'https://app.lobehub.com',
          fileId: 'file_video',
        }),
      ).toBe('https://app.lobehub.com/t/acme/f/file_video?download=1');
    });
  });
});
