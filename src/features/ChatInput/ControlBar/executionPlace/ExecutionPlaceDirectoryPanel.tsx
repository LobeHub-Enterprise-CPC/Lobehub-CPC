'use client';

import type { WorkingDirEntry } from '@lobechat/types';
import { getWorkingDirSourcePath } from '@lobechat/types';
import { Flexbox, Icon } from '@lobehub/ui';
import * as stylex from '@stylexjs/stylex';
import { CheckIcon, FolderClosedIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getWorkingDirectoryName } from '@/helpers/workingDirectoryPath';

import { AddRemoteFolderRow, ChooseLocalFolderRow, type FolderEntry } from '../folderRows';
import { ensureSelectedDirectoryListed } from './directoryList';
import { styles } from './style';

interface ExecutionPlaceDirectoryPanelProps {
  deviceDefaultCwd?: string;
  /** Render inside the remote-device panel instead of as its own card. */
  hasClearableSelection: boolean;
  isLocal: boolean;
  onClear: () => void;
  onClose: () => void;
  onPick: (entry: FolderEntry) => void;
  recents: WorkingDirEntry[];
  selectedDir?: string;
  targetDeviceId?: string;
}

export const ExecutionPlaceDirectoryPanel = ({
  deviceDefaultCwd,
  hasClearableSelection,
  isLocal,
  onClear,
  onClose,
  onPick,
  recents,
  selectedDir,
  targetDeviceId,
}: ExecutionPlaceDirectoryPanelProps) => {
  const { t } = useTranslation('device');
  const rows = ensureSelectedDirectoryListed(recents, selectedDir);
  const hasRows = rows.length > 0;

  return (
    <Flexbox data-testid={'execution-place-directory'} gap={4} {...stylex.props(styles.panel)}>
      <Flexbox horizontal align={'center'} distribution={'space-between'}>
        <span {...stylex.props(styles.headerLabel)}>{t('workingDirectory.recent')}</span>
        {hasClearableSelection ? (
          <button
            data-testid={'execution-place-restore-default'}
            type={'button'}
            onClick={onClear}
            {...stylex.props(styles.headerAction)}
          >
            {t('workingDirectory.clear')}
          </button>
        ) : null}
      </Flexbox>
      {hasRows ? (
        <div {...stylex.props(styles.directoryList)}>
          {rows.map((entry) => {
            const sourcePath = getWorkingDirSourcePath(entry);
            const active = sourcePath === selectedDir;
            const name = getWorkingDirectoryName(entry.path) ?? entry.path;
            return (
              <Flexbox
                horizontal
                align={'center'}
                data-active={active ? 'true' : 'false'}
                data-testid={`execution-place-dir-${sourcePath}`}
                gap={12}
                key={entry.path}
                onClick={() => onPick(entry)}
                {...stylex.props(styles.directoryRow, active && styles.directoryRowActive)}
              >
                <Icon icon={FolderClosedIcon} size={16} />
                <Flexbox flex={1} style={{ minWidth: 0 }}>
                  <div {...stylex.props(styles.directoryName)}>{name}</div>
                  <div {...stylex.props(styles.directoryPath)}>{entry.path}</div>
                </Flexbox>
                {active ? (
                  <Icon icon={CheckIcon} size={16} {...stylex.props(styles.check)} />
                ) : null}
              </Flexbox>
            );
          })}
        </div>
      ) : (
        <div data-testid={'execution-place-no-recent-dirs'} {...stylex.props(styles.emptyHint)}>
          {t('heteroAgent.executionPlace.noRecentDirectories', { ns: 'chat' })}
        </div>
      )}
      {isLocal ? (
        <ChooseLocalFolderRow defaultPath={selectedDir} tone={'quiet'} onPick={onPick} />
      ) : (
        <AddRemoteFolderRow
          defaultCwd={selectedDir || deviceDefaultCwd}
          deviceId={targetDeviceId}
          tone={'quiet'}
          onBeforeOpen={onClose}
          onPick={onPick}
        />
      )}
    </Flexbox>
  );
};
