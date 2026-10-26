'use client';

import { isDesktop } from '@lobechat/const';
import type { WorkingDirEntry } from '@lobechat/types';
import { getWorkingDirSourcePath } from '@lobechat/types';
import { toast } from '@lobehub/ui';
import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  resolveAgentWorkingDirectorySource,
  resolveTargetDeviceId,
} from '@/helpers/agentWorkingDirectory';
import {
  getWorkingDirectoryName,
  getWorkingDirectoryPathString,
} from '@/helpers/workingDirectoryPath';
import { useEffectiveAgencyConfig } from '@/hooks/useEffectiveAgencyConfig';
import { useAgentStore } from '@/store/agent';
import { useChatStore } from '@/store/chat';
import { topicSelectors } from '@/store/chat/selectors';
import { deviceSelectors, useDeviceStore } from '@/store/device';
import { useElectronStore } from '@/store/electron';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/selectors';

import { useTopicId } from '../hooks/useTopicId';
import { useCommitWorkingDirectory } from './useCommitWorkingDirectory';
import { useMigrateDeviceRecents } from './useMigrateDeviceRecents';

const SEARCH_THRESHOLD = 8;

const isValidWorkingDirEntry = (entry: WorkingDirEntry): boolean =>
  !!getWorkingDirectoryPathString(entry.path);

/**
 * Recents, the current directory, and the commit/clear writes shared by the
 * chip picker and the place picker's directory panel.
 *
 * `active` is the surface that is currently open: closing it clears the
 * search, opening it scrolls the checked row into view.
 */
export const useWorkingDirectoryController = (agentId: string, active: boolean) => {
  const topicId = useTopicId();
  const { t } = useTranslation('device');
  const [search, setSearch] = useState('');
  const activeRowRef = useRef<HTMLDivElement>(null);

  const isLogin = useUserStore(authSelectors.isLogin);
  useDeviceStore((s) => s.useFetchDevices)(isLogin || isDesktop);
  useMigrateDeviceRecents();

  const { agencyConfig, workspaceScoped } = useEffectiveAgencyConfig(agentId, { topicId });
  const currentDeviceId = useElectronStore((s) => s.gatewayDeviceInfo?.deviceId);
  const targetDeviceId = resolveTargetDeviceId(agencyConfig, currentDeviceId, {
    workspaceScoped,
  });
  const isLocalDevice = isDesktop && !!targetDeviceId && targetDeviceId === currentDeviceId;

  const rawRecents = useDeviceStore(deviceSelectors.getDeviceWorkingDirs(targetDeviceId));
  const recents = useMemo(() => rawRecents.filter(isValidWorkingDirEntry), [rawRecents]);
  const rawDeviceDefaultCwd = useDeviceStore(deviceSelectors.getDeviceDefaultCwd(targetDeviceId));
  const deviceDefaultCwd = getWorkingDirectoryPathString(rawDeviceDefaultCwd);
  const rawTopicWorkingDirectory = useChatStore(topicSelectors.getTopicWorkingDirectory(topicId));
  const topicWorkingDirectory = getWorkingDirectoryPathString(rawTopicWorkingDirectory);
  const topicWorkingDirectoryConfig = useChatStore((s) =>
    topicId ? topicSelectors.getTopicById(topicId)(s)?.metadata?.workingDirectoryConfig : undefined,
  );
  const rawLegacyAgentWorkingDirectory = useAgentStore(
    (s) => s.localAgentWorkingDirectoryMap[agentId],
  );
  const legacyAgentWorkingDirectory = getWorkingDirectoryPathString(rawLegacyAgentWorkingDirectory);

  const resolvedSelectedDir = resolveAgentWorkingDirectorySource({
    agencyConfig,
    currentDeviceId,
    deviceDefaultCwd,
    legacyAgentWorkingDirectory,
    topicWorkingDirectory,
    topicWorkingDirectoryConfig,
    workspaceScoped,
  });
  const selectedDir = getWorkingDirectoryPathString(resolvedSelectedDir);

  const agentChoice = targetDeviceId
    ? agencyConfig?.workingDirByDevice?.[targetDeviceId]
    : undefined;
  const hasClearableSelection = !!(
    topicWorkingDirectory ||
    agentChoice ||
    legacyAgentWorkingDirectory
  );

  const { clear, commit } = useCommitWorkingDirectory(agentId, topicId);
  const clearDeviceDefaultCwd = useDeviceStore((s) => s.clearDeviceDefaultCwd);
  const removeDeviceWorkingDir = useDeviceStore((s) => s.removeDeviceWorkingDir);
  const updateDeviceCwd = useDeviceStore((s) => s.updateDeviceCwd);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return recents;
    return recents.filter(
      (entry) =>
        getWorkingDirectoryName(entry.path)?.toLowerCase().includes(query) ||
        entry.path.toLowerCase().includes(query),
    );
  }, [recents, search]);

  const showSearch = recents.length > SEARCH_THRESHOLD;

  useEffect(() => {
    if (!active) setSearch('');
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      activeRowRef.current?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [active, filtered.length]);

  const handleRemoveRecent = (event: MouseEvent, entry: WorkingDirEntry) => {
    event.stopPropagation();
    if (!targetDeviceId) return;
    const removed = removeDeviceWorkingDir(targetDeviceId, entry.path);
    toast.success({
      actions: [
        {
          label: t('workingDirectory.undo'),
          onClick: () =>
            void removed.then(() => updateDeviceCwd(targetDeviceId, entry, { setDefault: false })),
          variant: 'text',
        },
      ],
      title: t('workingDirectory.removed', {
        name: getWorkingDirectoryName(entry.path) ?? entry.path,
      }),
    });
  };

  const handleToggleDefault = async (
    event: MouseEvent,
    entry: WorkingDirEntry,
    isDefault: boolean,
  ) => {
    event.stopPropagation();
    if (!targetDeviceId) return;

    try {
      if (isDefault) await clearDeviceDefaultCwd(targetDeviceId);
      else await updateDeviceCwd(targetDeviceId, entry, { setDefault: true });
    } catch {
      toast.error(t('workingDirectory.defaultUpdateFailed'));
    }
  };

  return {
    activeRowRef,
    clear,
    commit,
    deviceDefaultCwd,
    filtered,
    handleRemoveRecent,
    handleToggleDefault,
    hasClearableSelection,
    isLocalDevice,
    recents,
    search,
    selectedDir,
    setSearch,
    showSearch,
    targetDeviceId,
  };
};

export const isWorkingDirectorySourceActive = (entry: WorkingDirEntry, selectedDir?: string) =>
  getWorkingDirSourcePath(entry) === selectedDir;
