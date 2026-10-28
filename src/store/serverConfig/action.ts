import { isDesktop } from '@lobechat/const';
import { useLayoutEffect, useSyncExternalStore } from 'react';
import { type SWRResponse } from 'swr';
import type { StoreApi } from 'zustand';

import { useOnlyFetchOnceSWR } from '@/libs/swr';
import { serverConfigKeys } from '@/libs/swr/keys';
import { globalService } from '@/services/global';
import { getElectronStoreState, useElectronStore } from '@/store/electron';
import { electronSyncSelectors } from '@/store/electron/selectors';
import { type StoreSetter } from '@/store/types';
import { type GlobalRuntimeConfig } from '@/types/serverConfig';

import { type ServerConfigStore } from './store';

const CLOUD_DESKTOP_BUSINESS_FEATURES_FLAG = '__LOBECLOUD_DESKTOP_BUSINESS_FEATURES__';

const setDesktopBusinessFeaturesFlag = (enableBusinessFeatures: boolean | undefined) => {
  (globalThis as unknown as Record<string, boolean | undefined>)[
    CLOUD_DESKTOP_BUSINESS_FEATURES_FLAG
  ] = Boolean(enableBusinessFeatures);
};

type Setter = StoreSetter<ServerConfigStore>;
interface DesktopConfigContext {
  revision: number;
  scope: string | null;
}
export const createServerConfigSlice = (
  set: Setter,
  get: () => ServerConfigStore,
  api: StoreApi<ServerConfigStore>,
) => new ServerConfigActionImpl(set, get, api);

export class ServerConfigActionImpl {
  readonly #set: Setter;
  readonly #getInitialState: () => ServerConfigStore;
  #desktopContext: DesktopConfigContext = { revision: 0, scope: null };
  #appliedDesktopRevision = -1;

  constructor(set: Setter, get: () => ServerConfigStore, api: StoreApi<ServerConfigStore>) {
    this.#set = set;
    this.#getInitialState = api.getInitialState;
    void get;
  }

  #getDesktopContext = (): DesktopConfigContext => {
    const scope = electronSyncSelectors.serverConfigScope(getElectronStoreState());
    if (scope !== this.#desktopContext.scope) {
      this.#desktopContext = { revision: this.#desktopContext.revision + 1, scope };
    }
    return this.#desktopContext;
  };

  #subscribeDesktopContext = (onChange: () => void) =>
    useElectronStore.subscribe(() => {
      // Observe every transition, including A -> B -> A within one render.
      this.#getDesktopContext();
      onChange();
    });

  useInitServerConfig = (): SWRResponse<GlobalRuntimeConfig> => {
    const desktopContext = useSyncExternalStore(
      this.#subscribeDesktopContext,
      this.#getDesktopContext,
      this.#getDesktopContext,
    );
    const scope = isDesktop ? desktopContext.scope : undefined;
    const isCurrent = () => !isDesktop || this.#getDesktopContext() === desktopContext;

    useLayoutEffect(() => {
      if (!isDesktop || this.#appliedDesktopRevision === desktopContext.revision) return;
      this.#appliedDesktopRevision = desktopContext.revision;
      const initial = this.#getInitialState();
      setDesktopBusinessFeaturesFlag(false);
      this.#set(
        {
          _featureFlagOverrides: {},
          _originalFeatureFlags: null,
          billboard: null,
          canAccessDevDock: false,
          featureFlags: initial.featureFlags,
          serverConfig: initial.serverConfig,
          serverConfigInit: scope === null,
          serverConfigLoaded: false,
        },
        false,
        'resetServerConfigBinding',
      );
    }, [desktopContext, scope]);

    return useOnlyFetchOnceSWR<GlobalRuntimeConfig>(
      scope === null
        ? null
        : scope
          ? [serverConfigKeys.get, scope, desktopContext.revision]
          : serverConfigKeys.get,
      async () => {
        // Keep observing while this request is pending, even if its hook unmounts.
        // A legacy address has no persisted generation to distinguish a later A.
        const unsubscribe = isDesktop
          ? useElectronStore.subscribe(this.#getDesktopContext)
          : undefined;
        try {
          const data = await globalService.getGlobalConfig();
          // Fence the request itself, rather than a callback SWR may replace on
          // a later render. A previous binding never commits into this store.
          if (!isCurrent()) return data;
          setDesktopBusinessFeaturesFlag(data.serverConfig.enableBusinessFeatures);
          this.#set(
            {
              billboard: data.billboard ?? null,
              canAccessDevDock: data.serverFeatureFlags.enableDevDock === true,
              featureFlags: data.serverFeatureFlags,
              serverConfig: data.serverConfig,
              serverConfigInit: true,
              serverConfigLoaded: true,
            },
            false,
            'initServerConfig',
          );
          return data;
        } catch (error) {
          if (isCurrent()) {
            setDesktopBusinessFeaturesFlag(false);
            this.#set({ serverConfigInit: true }, false, 'initServerConfigFallback');
          }
          throw error;
        } finally {
          unsubscribe?.();
        }
      },
    );
  };
}

export type ServerConfigAction = Pick<ServerConfigActionImpl, keyof ServerConfigActionImpl>;
