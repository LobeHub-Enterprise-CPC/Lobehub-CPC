import { isDesktop } from '@lobechat/const';
import { buildRemoteUrl } from '@lobechat/utils/remoteUrl';
import { type PartialDeep } from 'type-fest';

import { type VersionResponseData } from '@/app/(backend)/api/version/route';
import { BusinessGlobalService } from '@/business/client/services/BusinessGlobalService';
import { lambdaClient } from '@/libs/trpc/client';
import { getElectronStoreState } from '@/store/electron';
import { electronSyncSelectors } from '@/store/electron/selectors';
import { type LobeAgentConfig } from '@/types/agent';
import { type GlobalRuntimeConfig } from '@/types/serverConfig';

const VERSION_URL = 'https://registry.npmmirror.com/@lobehub/chat/latest';
const SERVER_VERSION_URL = '/api/version';

class GlobalService extends BusinessGlobalService {
  /**
   * get latest version from npm
   */
  getLatestVersion = async (): Promise<string> => {
    const res = await fetch(VERSION_URL);
    const data = await res.json();

    return data['version'];
  };

  /**
   * get server version from /api/version
   * @returns version string if available, null only if server returns 404 (API doesn't exist on old server)
   * @throws Error for other failures (network errors, 500s, etc.) to allow SWR retry
   */
  getServerVersion = async (): Promise<string | null> => {
    // The remote server address is a tenant address (`https://host/orgs/acme`) or a
    // custom-domain root; `/api/version` is a tenant endpoint under it, so the
    // path is mounted under the address rather than resolved against its origin.
    const url = (() => {
      if (!isDesktop) return undefined;

      const remoteServerUrl = electronSyncSelectors.remoteServerUrl(getElectronStoreState());
      if (!remoteServerUrl) return undefined;

      return buildRemoteUrl(SERVER_VERSION_URL, remoteServerUrl).toString();
    })();

    if (!url) return null;

    const res = await fetch(url);

    // Only treat 404 as "server doesn't support version API"
    // Other errors (500, network issues) should throw to allow retry
    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      throw new Error(`Failed to fetch server version: ${res.status}`);
    }

    const data: VersionResponseData = await res.json();

    return data.version;
  };

  getGlobalConfig = async (): Promise<GlobalRuntimeConfig> => {
    return lambdaClient.config.getGlobalConfig.query();
  };

  getDefaultAgentConfig = async (): Promise<PartialDeep<LobeAgentConfig>> => {
    return lambdaClient.config.getDefaultAgentConfig.query();
  };
}

export const globalService = new GlobalService();
