import { setRemoteAppAddress } from '@lobechat/business-tenant/client';
import { isDesktop } from '@lobechat/const';
import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';
import { type StateCreator } from 'zustand/vanilla';

import { createDevtools } from '../middleware/createDevtools';
import { expose } from '../middleware/expose';
import { flattenActions } from '../utils/flattenActions';
import { type ElectronAppAction } from './actions/app';
import { createElectronAppSlice } from './actions/app';
import { type CurrentRouteMetaAction } from './actions/currentRouteMeta';
import { createCurrentRouteMetaSlice } from './actions/currentRouteMeta';
import { type ElectronGatewayAction } from './actions/gateway';
import { gatewaySlice } from './actions/gateway';
import { type RecentPagesAction } from './actions/recentPages';
import { createRecentPagesSlice } from './actions/recentPages';
import { type ElectronSettingsAction } from './actions/settings';
import { settingsSlice } from './actions/settings';
import { type ElectronRemoteServerAction } from './actions/sync';
import { remoteSyncSlice } from './actions/sync';
import { type TabPagesAction } from './actions/tabPages';
import { createTabPagesSlice } from './actions/tabPages';
import { type ElectronState } from './initialState';
import { initialState } from './initialState';
import { electronSyncSelectors } from './selectors';

//  ===============  Aggregate createStoreFn ============ //

export interface ElectronStore
  extends
    ElectronState,
    ElectronRemoteServerAction,
    ElectronAppAction,
    ElectronGatewayAction,
    ElectronSettingsAction,
    CurrentRouteMetaAction,
    RecentPagesAction,
    TabPagesAction {
  /* empty */
}

type ElectronStoreAction = ElectronRemoteServerAction &
  ElectronAppAction &
  ElectronGatewayAction &
  ElectronSettingsAction &
  CurrentRouteMetaAction &
  RecentPagesAction &
  TabPagesAction;

const createStore: StateCreator<ElectronStore, [['zustand/devtools', never]]> = (
  ...parameters: Parameters<StateCreator<ElectronStore, [['zustand/devtools', never]]>>
) => ({
  ...initialState,
  ...flattenActions<ElectronStoreAction>([
    remoteSyncSlice(...parameters),
    createElectronAppSlice(...parameters),
    gatewaySlice(...parameters),
    settingsSlice(...parameters),
    createCurrentRouteMetaSlice(...parameters),
    createRecentPagesSlice(...parameters),
    createTabPagesSlice(...parameters),
  ]),
});

//  ===============  Implement useStore ============ //

const devtools = createDevtools('electron');

export const useElectronStore = createWithEqualityFn<ElectronStore>()(
  devtools(createStore),
  shallow,
);

expose('electron', useElectronStore);

// The desktop renderer is not served by the app server: the tenant package builds
// every app link and asset URL on the configured remote (tenant) address.
const syncRemoteAppAddress = (state: ElectronStore) =>
  setRemoteAppAddress(isDesktop ? electronSyncSelectors.remoteServerUrl(state) : undefined);
syncRemoteAppAddress(useElectronStore.getState());
useElectronStore.subscribe(syncRemoteAppAddress);

export const getElectronStoreState = () => useElectronStore.getState();
