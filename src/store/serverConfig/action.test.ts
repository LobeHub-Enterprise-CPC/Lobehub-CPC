import type * as AppConstants from '@lobechat/const';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_FEATURE_FLAGS, mapFeatureFlagsEnvToState } from '@/config/featureFlags';
import { globalService } from '@/services/global';
import { useElectronStore } from '@/store/electron';
import { initialState as initialElectronState } from '@/store/electron/initialState';
import { electronSyncSelectors } from '@/store/electron/selectors';
import type { GlobalRuntimeConfig } from '@/types/serverConfig';

import { initServerConfigStore } from './store';

const mode = vi.hoisted(() => ({ desktop: true }));
vi.mock('@lobechat/const', async (original) => ({
  ...(await original<typeof AppConstants>()),
  get isDesktop() {
    return mode.desktop;
  },
}));
vi.mock('@/services/global', () => ({ globalService: { getGlobalConfig: vi.fn() } }));

const config = (name: string): GlobalRuntimeConfig => ({
  serverConfig: {
    aiProvider: {},
    telemetry: { langfuse: name === 'A' },
    enableBusinessFeatures: name === 'A',
  },
  serverFeatureFlags: {
    ...mapFeatureFlagsEnvToState(DEFAULT_FEATURE_FLAGS),
    enableDevDock: name === 'A',
  },
});
const configA = config('A');
const configB = config('B');
const binding = (name: string, generation = name) => ({
  active: true,
  storageMode: 'cloud' as const,
  cloudTenant: {
    generation,
    entryUrl: `https://example.test/t/${name}`,
    identity: {
      tenantId: name,
      subject: 'same-sub',
      issuer: `https://example.test/t/${name}/oidc`,
    },
    display: { account: 'same-sub' },
  },
});
const pending = (name: string) => ({
  account: 'same-sub',
  confirmationId: `pending-${name}`,
  entryUrl: `https://example.test/t/${name}`,
  expiresAt: 9999999999999,
  generation: `pending-${name}`,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const mount = (store = initServerConfigStore({}), cache = new Map()) => {
  const wrapper = ({ children }: PropsWithChildren) =>
    createElement(
      SWRConfig,
      { value: { provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false } },
      children,
    );
  const hook = renderHook(() => store.getState().useInitServerConfig(), { wrapper });
  return { store, ...hook };
};
const commit = (name: string) =>
  act(() =>
    useElectronStore.setState({ dataSyncConfig: binding(name), isInitRemoteServerConfig: true }),
  );
const legacyBinding = (name: string) => ({
  active: true,
  storageMode: 'selfHost' as const,
  remoteServerUrl: `https://example.test/t/${name}`,
});
const restoreLegacy = (name: string) =>
  act(() =>
    useElectronStore.setState({
      dataSyncConfig: legacyBinding(name),
      isInitRemoteServerConfig: true,
    }),
  );

beforeEach(() => {
  mode.desktop = true;
  useElectronStore.setState(initialElectronState);
  vi.mocked(globalService.getGlobalConfig).mockReset().mockResolvedValue(configA);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('server config reads through the actual SWR hook', () => {
  it('loads a restored active legacy selfHost session without a cloudTenant or generation', async () => {
    restoreLegacy('A');
    const { store } = mount();
    await act(async () => {});
    expect({
      scope: electronSyncSelectors.serverConfigScope(useElectronStore.getState()),
      requests: vi.mocked(globalService.getGlobalConfig).mock.calls.length,
    }).toEqual({ scope: expect.any(String), requests: 1 });
    await waitFor(() => expect(store.getState().serverConfigLoaded).toBe(true));
    expect(store.getState().serverConfig).toEqual(configA.serverConfig);
    expect(globalService.getGlobalConfig).toHaveBeenCalledOnce();
  });

  it('clears loaded legacy configuration on an address switch and logout', async () => {
    restoreLegacy('A');
    const { store } = mount();
    await waitFor(() => expect(store.getState().serverConfigLoaded).toBe(true));
    const next = deferred<GlobalRuntimeConfig>();
    vi.mocked(globalService.getGlobalConfig).mockReturnValueOnce(next.promise);
    restoreLegacy('B');
    expect(store.getState().serverConfig).toEqual({ aiProvider: {}, telemetry: {} });
    expect(store.getState().serverConfigLoaded).toBe(false);
    await act(async () => next.resolve(configB));
    expect(store.getState().serverConfig).toEqual(configB.serverConfig);
    act(() =>
      useElectronStore.setState({ dataSyncConfig: { storageMode: 'selfHost', active: false } }),
    );
    expect(store.getState().serverConfig).toEqual({ aiProvider: {}, telemetry: {} });
    expect(store.getState().serverConfigLoaded).toBe(false);
  });

  it.each(['success', 'failure'] as const)(
    'fences the old legacy A %s after switching to B',
    async (outcome) => {
      restoreLegacy('A');
      const old = deferred<GlobalRuntimeConfig>();
      const latestConfig = {
        ...configB,
        serverConfig: { ...configB.serverConfig, enableBusinessFeatures: true },
      };
      vi.mocked(globalService.getGlobalConfig)
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(latestConfig);
      const { store } = mount();
      await waitFor(() => expect(globalService.getGlobalConfig).toHaveBeenCalledOnce());
      restoreLegacy('B');
      await waitFor(() => expect(store.getState().serverConfig).toEqual(latestConfig.serverConfig));
      await act(async () => {
        if (outcome === 'success') old.resolve(configA);
        else old.reject(new Error('old legacy A'));
      });
      expect(store.getState().serverConfig).toEqual(latestConfig.serverConfig);
      expect((globalThis as Record<string, unknown>).__LOBECLOUD_DESKTOP_BUSINESS_FEATURES__).toBe(
        true,
      );
    },
  );

  it.each(['success', 'failure'] as const)(
    'fences the first legacy A %s after A to B to A',
    async (outcome) => {
      restoreLegacy('A');
      const old = deferred<GlobalRuntimeConfig>();
      const latestConfig = {
        ...configB,
        serverConfig: { ...configB.serverConfig, enableBusinessFeatures: true },
      };
      vi.mocked(globalService.getGlobalConfig)
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(configB)
        .mockResolvedValueOnce(latestConfig);
      const { store } = mount();
      await waitFor(() => expect(globalService.getGlobalConfig).toHaveBeenCalledOnce());
      restoreLegacy('B');
      await waitFor(() => expect(store.getState().serverConfig).toEqual(configB.serverConfig));
      restoreLegacy('A');
      await waitFor(() => expect(globalService.getGlobalConfig).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(store.getState().serverConfig).toEqual(latestConfig.serverConfig));
      await act(async () => {
        if (outcome === 'success') old.resolve(configA);
        else old.reject(new Error('first legacy A'));
      });
      expect(store.getState().serverConfig).toEqual(latestConfig.serverConfig);
      expect((globalThis as Record<string, unknown>).__LOBECLOUD_DESKTOP_BUSINESS_FEATURES__).toBe(
        true,
      );
    },
  );

  it('starts a fresh legacy A request after a batched address round trip', async () => {
    restoreLegacy('A');
    const old = deferred<GlobalRuntimeConfig>();
    vi.mocked(globalService.getGlobalConfig)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(configB);
    const { store } = mount();
    await waitFor(() => expect(globalService.getGlobalConfig).toHaveBeenCalledOnce());
    act(() => {
      useElectronStore.setState({ dataSyncConfig: legacyBinding('B') });
      useElectronStore.setState({ dataSyncConfig: legacyBinding('A') });
    });
    await waitFor(() => expect(store.getState().serverConfig).toEqual(configB.serverConfig));
    expect(globalService.getGlobalConfig).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(configA));
    expect(store.getState().serverConfig).toEqual(configB.serverConfig);
  });

  it('tracks legacy address changes while an old request outlives its hook', async () => {
    restoreLegacy('A');
    const old = deferred<GlobalRuntimeConfig>();
    vi.mocked(globalService.getGlobalConfig)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(configB);
    const store = initServerConfigStore({});
    const cache = new Map();
    const first = mount(store, cache);
    await waitFor(() => expect(globalService.getGlobalConfig).toHaveBeenCalledOnce());
    first.unmount();
    restoreLegacy('B');
    restoreLegacy('A');
    mount(store, cache);
    await waitFor(() => expect(store.getState().serverConfig).toEqual(configB.serverConfig));
    expect(globalService.getGlobalConfig).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(configA));
    expect(store.getState().serverConfig).toEqual(configB.serverConfig);
  });

  it.each(['success', 'failure'] as const)('fences legacy %s after logout', async (outcome) => {
    restoreLegacy('A');
    const old = deferred<GlobalRuntimeConfig>();
    vi.mocked(globalService.getGlobalConfig).mockReturnValueOnce(old.promise);
    const { store } = mount();
    await waitFor(() => expect(globalService.getGlobalConfig).toHaveBeenCalledOnce());
    act(() =>
      useElectronStore.setState({ dataSyncConfig: { ...legacyBinding('A'), active: false } }),
    );
    await act(async () => {
      if (outcome === 'success') old.resolve(configA);
      else old.reject(new Error('logged out legacy A'));
    });
    expect(store.getState().serverConfigLoaded).toBe(false);
    expect(store.getState().serverConfig).toEqual({ aiProvider: {}, telemetry: {} });
    expect((globalThis as Record<string, unknown>).__LOBECLOUD_DESKTOP_BUSINESS_FEATURES__).toBe(
      false,
    );
  });

  it.each(['success', 'failure'] as const)(
    'keeps main generation fencing for confirmed A to B to new A (%s)',
    async (outcome) => {
      commit('A');
      const old = deferred<GlobalRuntimeConfig>();
      const latestConfig = {
        ...configB,
        serverConfig: { ...configB.serverConfig, enableBusinessFeatures: true },
      };
      vi.mocked(globalService.getGlobalConfig)
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(configB)
        .mockResolvedValueOnce(latestConfig);
      const { store } = mount();
      await waitFor(() => expect(globalService.getGlobalConfig).toHaveBeenCalledOnce());
      commit('B');
      await waitFor(() => expect(store.getState().serverConfig).toEqual(configB.serverConfig));
      act(() => useElectronStore.setState({ dataSyncConfig: binding('A', 'new-A-generation') }));
      await waitFor(() => expect(store.getState().serverConfig).toEqual(latestConfig.serverConfig));
      await act(async () => {
        if (outcome === 'success') old.resolve(configA);
        else old.reject(new Error('first confirmed A'));
      });
      expect(store.getState().serverConfig).toEqual(latestConfig.serverConfig);
      expect((globalThis as Record<string, unknown>).__LOBECLOUD_DESKTOP_BUSINESS_FEATURES__).toBe(
        true,
      );
    },
  );

  it('does not read a platform address while desktop binding is hydrating or absent', async () => {
    useElectronStore.setState({ dataSyncConfig: binding('A'), isInitRemoteServerConfig: false });
    const { store } = mount();
    await act(async () => {});
    expect(globalService.getGlobalConfig).not.toHaveBeenCalled();
    expect(store.getState().serverConfigLoaded).toBe(false);
    expect(store.getState().serverConfig).toEqual({ aiProvider: {}, telemetry: {} });
    act(() =>
      useElectronStore.setState({
        isInitRemoteServerConfig: true,
        dataSyncConfig: { storageMode: 'cloud', active: false },
      }),
    );
    await act(async () => {});
    expect(globalService.getGlobalConfig).not.toHaveBeenCalled();
    expect(store.getState().serverConfigInit).toBe(true);
  });

  it('waits through pending confirmation, then automatically fetches the committed organization', async () => {
    useElectronStore.setState({
      isInitRemoteServerConfig: true,
      pendingAuthorizationConfirmation: pending('A'),
    });
    const { store } = mount();
    await act(async () => {});
    expect(globalService.getGlobalConfig).not.toHaveBeenCalled();
    commit('A');
    await waitFor(() => expect(store.getState().serverConfigLoaded).toBe(true));
    expect(store.getState().serverConfig).toEqual(configA.serverConfig);
    expect(globalService.getGlobalConfig).toHaveBeenCalledOnce();
  });

  it.each(['cloud', 'selfHost'] as const)(
    'loads a saved, hydrated %s identity on restart',
    async (storageMode) => {
      commit('A');
      act(() =>
        useElectronStore.setState({
          dataSyncConfig: {
            ...binding('A'),
            storageMode,
            remoteServerUrl: 'https://example.test/t/A',
          },
        }),
      );
      const { store, result } = mount();
      await waitFor(() => expect(result.current.data).toEqual(configA));
      expect(store.getState().serverConfigLoaded).toBe(true);
      expect(store.getState().canAccessDevDock).toBe(true);
    },
  );

  it('keeps Web anonymous configuration reads enabled', async () => {
    mode.desktop = false;
    const { store } = mount();
    await waitFor(() => expect(store.getState().serverConfigLoaded).toBe(true));
    expect(globalService.getGlobalConfig).toHaveBeenCalledOnce();
  });

  it('returns real failures and permits an explicit retry', async () => {
    commit('A');
    const failure = new Error('UNAUTHORIZED');
    vi.mocked(globalService.getGlobalConfig).mockRejectedValueOnce(failure);
    const { store, result } = mount();
    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(store.getState().serverConfigInit).toBe(true);
    expect(store.getState().serverConfigLoaded).toBe(false);
    await act(() => result.current.mutate());
    await waitFor(() => expect(store.getState().serverConfigLoaded).toBe(true));
    expect(globalService.getGlobalConfig).toHaveBeenCalledTimes(2);
  });

  it('retains A while B is pending, clears A on commit, and fetches B', async () => {
    commit('A');
    const { store } = mount();
    await waitFor(() => expect(store.getState().serverConfigLoaded).toBe(true));
    act(() => useElectronStore.setState({ pendingAuthorizationConfirmation: pending('B') }));
    expect(store.getState().serverConfig).toEqual(configA.serverConfig);
    expect(globalService.getGlobalConfig).toHaveBeenCalledOnce();
    const next = deferred<GlobalRuntimeConfig>();
    vi.mocked(globalService.getGlobalConfig).mockReturnValueOnce(next.promise);
    commit('B');
    expect(store.getState().serverConfigLoaded).toBe(false);
    expect(store.getState().canAccessDevDock).toBe(false);
    expect(store.getState().serverConfig).toEqual({ aiProvider: {}, telemetry: {} });
    await act(async () => next.resolve(configB));
    await waitFor(() => expect(store.getState().serverConfig).toEqual(configB.serverConfig));
  });

  it.each(['success', 'failure'] as const)(
    'ignores late A %s after B has loaded',
    async (outcome) => {
      commit('A');
      const old = deferred<GlobalRuntimeConfig>();
      const latestConfig: GlobalRuntimeConfig = {
        ...configB,
        serverConfig: { ...configB.serverConfig, enableBusinessFeatures: outcome === 'failure' },
      };
      vi.mocked(globalService.getGlobalConfig)
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(latestConfig);
      const { store } = mount();
      await waitFor(() => expect(globalService.getGlobalConfig).toHaveBeenCalledOnce());
      commit('B');
      await waitFor(() => expect(store.getState().serverConfig).toEqual(latestConfig.serverConfig));
      await act(async () => {
        if (outcome === 'success') old.resolve(configA);
        else old.reject(new Error('old A rejected'));
      });
      expect(store.getState().serverConfig).toEqual(latestConfig.serverConfig);
      expect(store.getState().serverConfigLoaded).toBe(true);
      expect((globalThis as Record<string, unknown>).__LOBECLOUD_DESKTOP_BUSINESS_FEATURES__).toBe(
        outcome === 'failure',
      );
    },
  );

  it.each(['success', 'failure'] as const)(
    'clears configuration on logout and ignores the old %s',
    async (outcome) => {
      commit('A');
      const old = deferred<GlobalRuntimeConfig>();
      vi.mocked(globalService.getGlobalConfig).mockReturnValueOnce(old.promise);
      const { store } = mount();
      await waitFor(() => expect(globalService.getGlobalConfig).toHaveBeenCalledOnce());
      act(() =>
        useElectronStore.setState({ dataSyncConfig: { storageMode: 'cloud', active: false } }),
      );
      await act(async () => {
        if (outcome === 'success') old.resolve(configA);
        else old.reject(new Error('old A rejected'));
      });
      expect(store.getState().serverConfig).toEqual({ aiProvider: {}, telemetry: {} });
      expect(store.getState().serverConfigLoaded).toBe(false);
      expect(store.getState().canAccessDevDock).toBe(false);
      expect(globalService.getGlobalConfig).toHaveBeenCalledOnce();
    },
  );

  it('clears loaded tenant configuration and local flag overrides on logout', async () => {
    commit('A');
    const { store } = mount();
    await waitFor(() => expect(store.getState().serverConfigLoaded).toBe(true));
    act(() =>
      store.setState({
        _featureFlagOverrides: { showMarket: false },
        _originalFeatureFlags: store.getState().featureFlags,
      }),
    );
    act(() =>
      useElectronStore.setState({ dataSyncConfig: { storageMode: 'cloud', active: false } }),
    );
    expect(store.getState().serverConfig).toEqual({ aiProvider: {}, telemetry: {} });
    expect(store.getState().serverConfigLoaded).toBe(false);
    expect(store.getState().canAccessDevDock).toBe(false);
    expect(store.getState()._featureFlagOverrides).toEqual({});
    expect(store.getState()._originalFeatureFlags).toBeNull();
    expect((globalThis as Record<string, unknown>).__LOBECLOUD_DESKTOP_BUSINESS_FEATURES__).toBe(
      false,
    );
  });
});
