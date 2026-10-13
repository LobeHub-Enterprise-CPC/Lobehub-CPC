import { isDesktop } from '@lobechat/const';
import { resolveRemoteUrl } from '@lobechat/utils/remoteUrl';
import { useMemo } from 'react';

import { useElectronStore } from '@/store/electron';
import { electronSyncSelectors } from '@/store/electron/selectors';

/**
 * A server-returned asset reference (avatar, file URL) in a form the renderer
 * can load.
 *
 * The desktop renderer is not served by the app server, so a server-relative
 * path (`/webapi/user/avatar/...`) is mounted under the remote server address,
 * keeping its tenant path prefix (`https://host/t/acme/webapi/...`). Absolute,
 * `data:` and `blob:` values pass through, and so does a path the server already
 * prefixed. On web the value is already relative to the serving origin.
 */
export const useRemoteAssetUrl = <T extends string | undefined>(value: T): T => {
  const remoteServerUrl = useElectronStore(electronSyncSelectors.remoteServerUrl);

  return useMemo(() => {
    if (!isDesktop || !remoteServerUrl || !value) return value;

    return resolveRemoteUrl(value, remoteServerUrl) as T;
  }, [value, remoteServerUrl]);
};
