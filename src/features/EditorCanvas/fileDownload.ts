import { buildRemoteUrl, relativeToRemoteBase } from '@lobechat/utils/remoteUrl';

import { getAppBaseUrl } from '@/libs/tenant/appBaseUrl';

import { getRegisteredAttachment } from './attachmentRegistry';

const FILE_PROXY_PATH = /^\/f\/[^/]+$/;

interface FileDownloadUrlOptions {
  /** The app address the file proxy lives under; defaults to {@link getAppBaseUrl}. */
  appUrl?: string;
  baseUrl?: string;
  downloadUrl?: string;
  fileId?: string;
}

/**
 * The file proxy normally returns an inline preview URL. Opting into its download
 * response lets the browser stream the file and expose native progress instead of
 * waiting for the whole file to become a client-side Blob.
 */
export const getFileDownloadUrl = (url: string, options: FileDownloadUrlOptions = {}): string => {
  const baseUrl =
    options.baseUrl ?? (typeof window === 'undefined' ? undefined : window.location.href);

  try {
    const appUrl = options.appUrl ?? getAppBaseUrl();
    const downloadUrl = new URL(options.downloadUrl ?? url, baseUrl);

    // The file proxy under this app's tenant path. Any origin: a link minted on an
    // earlier active entry still reaches the proxy through that entry's redirect.
    if (FILE_PROXY_PATH.test(relativeToRemoteBase(downloadUrl.pathname, appUrl) ?? '')) {
      downloadUrl.searchParams.set('download', '1');
      return downloadUrl.toString();
    }

    if (options.fileId) {
      const proxyUrl = buildRemoteUrl(`/f/${encodeURIComponent(options.fileId)}`, appUrl);
      proxyUrl.searchParams.set('download', '1');
      return proxyUrl.toString();
    }

    return url;
  } catch {
    return url;
  }
};

export const openFileDownload = (url: string): void => {
  // Keep this synchronous with the click gesture so popup blockers allow the download tab.
  const attachment = getRegisteredAttachment(url);
  window.open(
    getFileDownloadUrl(url, {
      downloadUrl: attachment?.downloadUrl,
      fileId: attachment?.fileId,
    }),
    '_blank',
    'noopener,noreferrer',
  );
};
