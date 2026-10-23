import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as activeWorkspaceSlugModule from '@/business/client/hooks/useActiveWorkspaceSlug';
import type * as VersionConstants from '@/const/version';
import { CURRENT_VERSION } from '@/const/version';
import { globalService } from '@/services/global';
import { useElectronStore } from '@/store/electron';
import { initialState as electronInitialState } from '@/store/electron/initialState';
import { useGlobalStore } from '@/store/global';
import { initialState } from '@/store/global/initialState';
import { switchLang } from '@/utils/client/switchLang';
import { withSWR } from '~test-utils';

const versionContext = vi.hoisted(() => ({ desktop: false, webVersion: '2.2.14' }));

vi.mock('@/const/version', async (importOriginal) => ({
  ...(await importOriginal<typeof VersionConstants>()),
  CURRENT_VERSION: '2.2.14',
  get isDesktop() {
    return versionContext.desktop;
  },
}));

vi.mock('@/const/appVersion', () => ({
  get WEB_APP_VERSION() {
    return versionContext.webVersion;
  },
}));

vi.mock('@/utils/client/switchLang', () => ({
  switchLang: vi.fn(),
}));

vi.mock('@/services/global', () => ({
  globalService: {
    getLatestVersion: vi.fn(),
    getServerVersion: vi.fn(),
  },
}));

describe('desktop server-version checks follow the committed organization', () => {
  beforeEach(() => {
    versionContext.desktop = true;
    // Cloud mode judges the build's cloud address, not the tenant entry. Pin it so the
    // suite does not follow @lobechat/business-const OFFICIAL_URL (official on CPC).
    vi.stubEnv('OFFICIAL_CLOUD_SERVER', 'https://host');
    useGlobalStore.setState({ ...initialState, isServerVersionOutdated: false });
    useElectronStore.setState(electronInitialState);
    vi.mocked(globalService.getServerVersion).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const connect = (url: string) =>
    useElectronStore.setState({
      isInitRemoteServerConfig: true,
      dataSyncConfig: { active: true, storageMode: 'selfHost', remoteServerUrl: url },
    });
  const renderCheck = () =>
    renderHook(() => useGlobalStore.getState().useCheckServerVersion(), { wrapper: withSWR });

  it('does not label an unbound cloud session as an old server', async () => {
    vi.mocked(globalService.getServerVersion).mockResolvedValue(null);
    renderCheck();
    await act(async () => {});
    expect(globalService.getServerVersion).not.toHaveBeenCalled();
    expect(useGlobalStore.getState().isServerVersionOutdated).toBe(false);
  });

  it('waits for a committed cloud organization even after config hydration', async () => {
    useElectronStore.setState({
      isInitRemoteServerConfig: true,
      dataSyncConfig: { active: true, storageMode: 'cloud', remoteServerUrl: 'https://platform' },
    });
    vi.mocked(globalService.getServerVersion).mockResolvedValue(null);
    renderCheck();
    await act(async () => {});
    expect(globalService.getServerVersion).not.toHaveBeenCalled();
    expect(useGlobalStore.getState().isServerVersionOutdated).toBe(false);
  });

  it('checks the committed cloud organization with the same upstream version', async () => {
    useElectronStore.setState({
      isInitRemoteServerConfig: true,
      dataSyncConfig: {
        active: true,
        storageMode: 'cloud',
        cloudTenant: {
          entryUrl: 'https://host/t/acme',
          generation: 'login-A',
          display: { account: 'sub' },
          identity: { issuer: 'https://host/t/acme/oidc', subject: 'sub', tenantId: 'A' },
        },
      },
    });
    vi.mocked(globalService.getServerVersion).mockResolvedValue('2.2.14');
    renderCheck();
    await waitFor(() => expect(useGlobalStore.getState().serverVersion).toBe('2.2.14'));
    expect(useGlobalStore.getState().isServerVersionOutdated).toBe(false);
  });

  it('does not request a version when the cloud address is an official lobehub.com host', async () => {
    vi.stubEnv('OFFICIAL_CLOUD_SERVER', 'https://app.lobehub.com');
    useElectronStore.setState({
      isInitRemoteServerConfig: true,
      dataSyncConfig: {
        active: true,
        storageMode: 'cloud',
        cloudTenant: {
          entryUrl: 'https://app.lobehub.com/t/acme',
          generation: 'login-A',
          display: { account: 'sub' },
          identity: {
            issuer: 'https://app.lobehub.com/t/acme/oidc',
            subject: 'sub',
            tenantId: 'A',
          },
        },
      },
    });
    vi.mocked(globalService.getServerVersion).mockResolvedValue('2.1.0');
    renderCheck();
    await act(async () => {});
    expect(globalService.getServerVersion).not.toHaveBeenCalled();
    expect(useGlobalStore.getState().isServerVersionOutdated).toBe(false);
    expect(useGlobalStore.getState().serverVersion).toBeUndefined();
  });

  it('keeps the warning for an actual server without the version API', async () => {
    connect('https://host/t/acme');
    vi.mocked(globalService.getServerVersion).mockResolvedValue(null);
    renderCheck();
    await waitFor(() => expect(useGlobalStore.getState().isServerVersionOutdated).toBe(true));
  });

  it('clears the warning on logout and checks the next organization independently', async () => {
    connect('https://host/t/old');
    vi.mocked(globalService.getServerVersion)
      .mockResolvedValueOnce('2.1.0')
      .mockResolvedValue('2.2.14');
    renderCheck();
    await waitFor(() => expect(useGlobalStore.getState().isServerVersionOutdated).toBe(true));
    act(() => useElectronStore.setState({ dataSyncConfig: { storageMode: 'cloud' } }));
    expect(useGlobalStore.getState().isServerVersionOutdated).toBe(false);
    act(() => connect('https://host/t/current'));
    await waitFor(() => expect(globalService.getServerVersion).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(useGlobalStore.getState().serverVersion).toBe('2.2.14'));
    expect(useGlobalStore.getState().isServerVersionOutdated).toBe(false);
  });

  it('ignores an old organization response after switching', async () => {
    let completeOld!: (value: string | null) => void;
    connect('https://host/t/slow');
    vi.mocked(globalService.getServerVersion)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          completeOld = resolve;
        }),
      )
      .mockResolvedValue('2.2.14');
    renderCheck();
    await waitFor(() => expect(globalService.getServerVersion).toHaveBeenCalledTimes(1));
    act(() => connect('https://host/t/current'));
    await waitFor(() => expect(useGlobalStore.getState().serverVersion).toBe('2.2.14'));
    await act(async () => completeOld('2.1.0'));
    expect(useGlobalStore.getState().serverVersion).toBe('2.2.14');
    expect(useGlobalStore.getState().isServerVersionOutdated).toBe(false);
  });
});

describe('generalActionSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    versionContext.desktop = false;
    versionContext.webVersion = '2.2.14';
    useGlobalStore.setState(initialState);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('updateSystemStatus', () => {
    it('should not update status when not initialized', () => {
      const { result } = renderHook(() => useGlobalStore());

      act(() => {
        result.current.updateSystemStatus({ noWideScreen: false });
      });

      expect(result.current.status).toEqual(initialState.status);
    });

    it('should update status when initialized', () => {
      const { result } = renderHook(() => useGlobalStore());

      act(() => {
        useGlobalStore.setState({ isStatusInit: true });
        result.current.updateSystemStatus({ noWideScreen: false });
      });

      expect(result.current.status.noWideScreen).toBe(false);
    });

    it('should not update if new status equals current status', () => {
      const { result } = renderHook(() => useGlobalStore());
      const saveToLocalStorageSpy = vi.spyOn(result.current.statusStorage, 'saveToLocalStorage');

      act(() => {
        useGlobalStore.setState({ isStatusInit: true });
        result.current.updateSystemStatus({ noWideScreen: initialState.status.noWideScreen });
      });

      expect(saveToLocalStorageSpy).not.toHaveBeenCalled();
    });

    it('should save to localStorage when status is updated', () => {
      const { result } = renderHook(() => useGlobalStore());
      const saveToLocalStorageSpy = vi.spyOn(result.current.statusStorage, 'saveToLocalStorage');

      act(() => {
        useGlobalStore.setState({ isStatusInit: true });
        result.current.updateSystemStatus({ noWideScreen: false });
      });

      expect(saveToLocalStorageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ noWideScreen: false }),
      );
    });

    it('should persist the selected task list view mode', () => {
      const { result } = renderHook(() => useGlobalStore());
      const saveToLocalStorageSpy = vi.spyOn(result.current.statusStorage, 'saveToLocalStorage');

      act(() => {
        useGlobalStore.setState({ isStatusInit: true });
        result.current.updateSystemStatus({ taskListViewMode: 'kanban' });
      });

      expect(result.current.status.taskListViewMode).toBe('kanban');
      expect(saveToLocalStorageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ taskListViewMode: 'kanban' }),
      );
    });

    it('should merge nested objects correctly', () => {
      const { result } = renderHook(() => useGlobalStore());

      act(() => {
        useGlobalStore.setState({ isStatusInit: true });
        result.current.updateSystemStatus({
          expandSessionGroupKeys: ['test1', 'test2'],
        });
      });

      expect(result.current.status.expandSessionGroupKeys).toEqual(['test1', 'test2']);
    });
  });

  describe('switchLocale', () => {
    it('should update language in system status and call switchLang', () => {
      const { result } = renderHook(() => useGlobalStore());
      const locale = 'zh-CN';

      act(() => {
        useGlobalStore.setState({ isStatusInit: true });
        result.current.switchLocale(locale);
      });

      expect(result.current.status.language).toBe(locale);
      expect(switchLang).toHaveBeenCalledWith(locale);
    });

    it('should not update language if status is not initialized', () => {
      const { result } = renderHook(() => useGlobalStore());
      const locale = 'zh-CN';

      act(() => {
        result.current.switchLocale(locale);
      });

      expect(result.current.status.language).toBeUndefined();
    });
  });

  describe('browser popup routes', () => {
    it('keeps the active workspace in agent and topic popups', async () => {
      vi.spyOn(activeWorkspaceSlugModule, 'getActiveWorkspaceSlug').mockReturnValue('team');
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);

      await useGlobalStore.getState().openAgentInNewWindow('agent-1');
      await useGlobalStore.getState().openTopicInNewWindow('agent-1', 'topic-1');
      await useGlobalStore.getState().openGroupTopicInNewWindow('group-1', 'topic-1');

      expect(open).toHaveBeenNthCalledWith(
        1,
        '/team/agent/agent-1',
        'agent_agent-1',
        expect.any(String),
      );
      expect(open).toHaveBeenNthCalledWith(
        2,
        '/team/agent/agent-1/topic-1',
        'agent_agent-1_topic_topic-1',
        expect.any(String),
      );
      expect(open).toHaveBeenNthCalledWith(
        3,
        '/team/group/group-1/topic-1',
        'group_group-1_topic_topic-1',
        expect.any(String),
      );
    });
  });

  describe('useInitSystemStatus', () => {
    it('should reset transient UI states when loading from localStorage', async () => {
      const mockStatus = {
        ...initialState.status,
        showCommandMenu: true,
        showHotkeyHelper: true,
        noWideScreen: false,
      };

      const { result } = renderHook(() => useGlobalStore());
      const getFromLocalStorageSpy = vi
        .spyOn(result.current.statusStorage, 'getFromLocalStorage')
        .mockResolvedValueOnce(mockStatus);

      const { result: hookResult } = renderHook(() => useGlobalStore().useInitSystemStatus(), {
        wrapper: withSWR,
      });

      await act(async () => {
        await hookResult.current.data;
      });

      expect(getFromLocalStorageSpy).toHaveBeenCalled();
      expect(useGlobalStore.getState().isStatusInit).toBe(true);
      expect(useGlobalStore.getState().status.showCommandMenu).toBe(false);
      expect(useGlobalStore.getState().status.showHotkeyHelper).toBe(false);
      expect(useGlobalStore.getState().status.noWideScreen).toBe(false);
    });
  });

  describe('useCheckLatestVersion', () => {
    it.each([
      { desktop: false, expected: undefined, latest: '2.3.0' },
      { desktop: false, expected: true, latest: '2.4.0' },
      { desktop: true, expected: true, latest: '2.3.0' },
    ])(
      'compares $latest against the platform version (desktop: $desktop)',
      async ({ desktop, expected, latest }) => {
        versionContext.desktop = desktop;
        versionContext.webVersion = '2.3.0';
        vi.mocked(globalService.getLatestVersion).mockResolvedValueOnce(latest);

        const { result } = renderHook(() => useGlobalStore().useCheckLatestVersion(), {
          wrapper: withSWR,
        });

        await waitFor(() => expect(result.current.data).toBe(latest));

        expect(useGlobalStore.getState().hasNewVersion).toBe(expected);
        expect(useGlobalStore.getState().latestVersion).toBe(expected ? latest : undefined);
      },
    );

    it('should not fetch version when check is disabled', () => {
      const getLatestVersionSpy = vi.spyOn(globalService, 'getLatestVersion');

      renderHook(() => useGlobalStore().useCheckLatestVersion(false), {
        wrapper: withSWR,
      });

      expect(getLatestVersionSpy).not.toHaveBeenCalled();
    });

    it('should set hasNewVersion when major version is newer', async () => {
      const latestVersion = '999.0.0';
      vi.spyOn(globalService, 'getLatestVersion').mockResolvedValueOnce(latestVersion);

      const { result } = renderHook(() => useGlobalStore().useCheckLatestVersion(), {
        wrapper: withSWR,
      });

      await act(async () => {
        await result.current.data;
      });

      expect(useGlobalStore.getState().hasNewVersion).toBe(true);
      expect(useGlobalStore.getState().latestVersion).toBe(latestVersion);
    });

    it('should not set hasNewVersion for same major.minor version', async () => {
      const currentParts = CURRENT_VERSION.split('.');
      const latestVersion = `${currentParts[0]}.${currentParts[1]}.999`;
      vi.spyOn(globalService, 'getLatestVersion').mockResolvedValueOnce(latestVersion);

      const { result } = renderHook(() => useGlobalStore().useCheckLatestVersion(), {
        wrapper: withSWR,
      });

      await act(async () => {
        await result.current.data;
      });

      // Reset hasNewVersion and latestVersion
      useGlobalStore.setState({ hasNewVersion: undefined, latestVersion: undefined });

      expect(useGlobalStore.getState().hasNewVersion).toBeUndefined();
      expect(useGlobalStore.getState().latestVersion).toBeUndefined();
    });

    it('should not set hasNewVersion when version is invalid', async () => {
      vi.spyOn(globalService, 'getLatestVersion').mockResolvedValueOnce('invalid.version');

      const { result } = renderHook(() => useGlobalStore().useCheckLatestVersion(), {
        wrapper: withSWR,
      });

      await act(async () => {
        await result.current.data;
      });

      // Reset hasNewVersion and latestVersion
      useGlobalStore.setState({ hasNewVersion: undefined, latestVersion: undefined });

      expect(useGlobalStore.getState().hasNewVersion).toBeUndefined();
      expect(useGlobalStore.getState().latestVersion).toBeUndefined();
    });
  });
});
