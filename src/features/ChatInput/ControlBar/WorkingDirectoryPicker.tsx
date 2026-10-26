'use client';

import type { WorkingDirEntry } from '@lobechat/types';
import { getWorkingDirSourcePath } from '@lobechat/types';
import {
  ActionIcon,
  createStaticStyles,
  cssVar,
  cx,
  Flexbox,
  Icon,
  Input,
  Popover,
  Tooltip,
} from '@lobehub/ui';
import { CheckIcon, ChevronDownIcon, SearchIcon, StarIcon, XIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { getWorkingDirectoryName } from '@/helpers/workingDirectoryPath';

import DashedFolderIcon from './DashedFolderIcon';
import DirIcon from './DirIcon';
import { AddRemoteFolderRow, ChooseLocalFolderRow } from './folderRows';
import { useWorkingDirectoryController } from './useWorkingDirectoryController';
import { workingDirectoryChipStyles } from './workingDirectoryChipStyles';

const styles = createStaticStyles(({ css }) => ({
  badge: css`
    flex: none;

    padding-inline: 5px;
    border-radius: 999px;

    font-size: 10px;
    line-height: 15px;
    color: ${cssVar.colorTextTertiary};

    background: ${cssVar.colorFillSecondary};
  `,
  clearText: css`
    cursor: pointer;

    padding-block: 6px 2px;
    padding-inline: 8px;

    font-size: 11px;
    font-weight: 500;
    color: ${cssVar.colorTextTertiary};

    transition: color 0.2s;

    &:hover {
      color: ${cssVar.colorText};
    }
  `,
  dirItem: css`
    cursor: pointer;

    padding-block: 6px;
    padding-inline: 8px;
    border-radius: ${cssVar.borderRadius};

    transition: background-color 0.2s;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }

    /* Reveal the row actions (set-default / remove) only on hover. */
    &:hover .wd-row-actions {
      display: flex;
    }
  `,
  dirItemActive: css`
    background: ${cssVar.colorFillTertiary};
  `,
  dirName: css`
    overflow: hidden;

    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  dirPath: css`
    overflow: hidden;

    font-size: 11px;
    color: ${cssVar.colorTextDescription};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  rowActions: css`
    display: none;
    flex: none;
    gap: 2px;
    align-items: center;
  `,
  scrollContainer: css`
    overflow-y: auto;
    max-height: 320px;
  `,
  searchBar: css`
    padding-block: 2px;
    padding-inline: 8px;
    border-block-end: 1px solid ${cssVar.colorSplit};
  `,
  sectionTitle: css`
    padding-block: 6px 2px;
    padding-inline: 8px;

    font-size: 11px;
    font-weight: 500;
    color: ${cssVar.colorTextQuaternary};
  `,
}));

interface WorkingDirectoryPickerProps {
  agentId: string;
}

/**
 * Unified working-directory picker for both local and remote runs. Recents come
 * from the target device's `device.workingDirs`; picks write through the unified
 * `useCommitWorkingDirectory` (topic override / agent per-device choice). When
 * the target is this machine, the native folder dialog is offered; a true remote
 * device falls back to manual path entry (its filesystem isn't browsable here).
 *
 * The device-wide **default** directory (`device.defaultCwd`) is surfaced
 * explicitly — the row carrying it wears a "default" badge, and any row can be
 * promoted to the default from its hover actions — so the fallback the agent
 * runs in when nothing is picked is never invisible.
 */
const WorkingDirectoryPicker = memo<WorkingDirectoryPickerProps>(({ agentId }) => {
  const { t } = useTranslation('device');
  const [open, setOpen] = useState(false);
  const {
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
  } = useWorkingDirectoryController(agentId, open);

  const pick = async (entry: WorkingDirEntry) => {
    await commit(entry);
    setOpen(false);
  };

  const renderRow = (entry: WorkingDirEntry) => {
    const sourcePath = getWorkingDirSourcePath(entry);
    const isActive = sourcePath === selectedDir;
    const isDefault = !!deviceDefaultCwd && sourcePath === deviceDefaultCwd;
    const defaultActionLabel = t(
      isDefault ? 'workingDirectory.clearDefault' : 'workingDirectory.setDefault',
    );
    return (
      <Flexbox
        horizontal
        align={'center'}
        className={cx(styles.dirItem, isActive && styles.dirItemActive)}
        gap={8}
        key={entry.path}
        ref={isActive ? activeRowRef : undefined}
        onClick={() => void pick(entry)}
      >
        <DirIcon repoType={entry.repoType} />
        <Flexbox flex={1} style={{ minWidth: 0 }}>
          <Flexbox horizontal align={'center'} gap={6}>
            <div className={styles.dirName}>
              {getWorkingDirectoryName(entry.path) ?? entry.path}
            </div>
            {isDefault && (
              <span className={styles.badge}>{t('workingDirectory.defaultBadge')}</span>
            )}
          </Flexbox>
          <div className={styles.dirPath}>{entry.path}</div>
        </Flexbox>
        <Flexbox horizontal align={'center'} gap={2} style={{ flex: 'none' }}>
          {/* The same Star toggles the device default in both directions. Remove
              (X) is hidden on the active row: you can't remove the selection out
              from under yourself. */}
          <div className={cx('wd-row-actions', styles.rowActions)}>
            <ActionIcon
              active={isDefault}
              aria-label={defaultActionLabel}
              aria-pressed={isDefault}
              icon={StarIcon}
              size={{ blockSize: 20, size: 13 }}
              title={defaultActionLabel}
              onClick={(e) => void handleToggleDefault(e, entry, isDefault)}
            />
            {!isActive && (
              <ActionIcon
                aria-label={t('workingDirectory.removeRecent')}
                icon={XIcon}
                size={{ blockSize: 20, size: 12 }}
                title={t('workingDirectory.removeRecent')}
                onClick={(e) => handleRemoveRecent(e, entry)}
              />
            )}
          </div>
          {isActive && (
            <Icon icon={CheckIcon} size={16} style={{ color: cssVar.colorSuccess, flex: 'none' }} />
          )}
        </Flexbox>
      </Flexbox>
    );
  };

  const content = (
    <Flexbox gap={4} style={{ maxWidth: 'calc(100vw - 48px)', width: 320 }}>
      {showSearch && (
        <div className={styles.searchBar}>
          <Input
            autoFocus
            placeholder={t('workingDirectory.searchPlaceholder')}
            prefix={<Icon icon={SearchIcon} size={14} />}
            size="small"
            style={{ paddingInline: 0 }}
            value={search}
            variant="borderless"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}
      <Flexbox horizontal align={'center'} distribution={'space-between'}>
        <div className={styles.sectionTitle}>{t('workingDirectory.recent')}</div>
        {hasClearableSelection && (
          <div className={styles.clearText} onClick={() => void clear().then(() => setOpen(false))}>
            {t('workingDirectory.clear')}
          </div>
        )}
      </Flexbox>
      <div className={styles.scrollContainer}>
        {filtered.length === 0 ? (
          <Flexbox
            align={'center'}
            justify={'center'}
            style={{ color: cssVar.colorTextQuaternary, fontSize: 12, padding: '12px 8px' }}
          >
            {search.trim() ? t('workingDirectory.noMatch') : t('workingDirectory.noRecent')}
          </Flexbox>
        ) : (
          filtered.map(renderRow)
        )}
      </div>

      {isLocalDevice ? (
        <ChooseLocalFolderRow defaultPath={selectedDir} onPick={pick} />
      ) : (
        <AddRemoteFolderRow
          // Start the browser at the directory this conversation actually runs in
          // (topic / agent override first), not the bare home folder.
          defaultCwd={selectedDir || deviceDefaultCwd}
          deviceId={targetDeviceId}
          onBeforeOpen={() => setOpen(false)}
          onPick={pick}
        />
      )}
    </Flexbox>
  );

  const displayName = selectedDir
    ? (getWorkingDirectoryName(selectedDir) ?? selectedDir)
    : t('workingDirectory.unselected');

  const trigger = (
    <div className={workingDirectoryChipStyles.chip}>
      {selectedDir ? (
        <DirIcon repoType={recents.find((r) => r.path === selectedDir)?.repoType} />
      ) : (
        <DashedFolderIcon size={14} />
      )}
      <span className={workingDirectoryChipStyles.label}>{displayName}</span>
      <Icon icon={ChevronDownIcon} size={12} />
    </div>
  );

  return (
    <Popover
      content={content}
      open={open}
      placement="bottomLeft"
      styles={{ content: { padding: 4 } }}
      trigger="click"
      onOpenChange={setOpen}
    >
      <div>
        {open ? (
          trigger
        ) : (
          <Tooltip title={selectedDir || t('workingDirectory.title')}>{trigger}</Tooltip>
        )}
      </div>
    </Popover>
  );
});

WorkingDirectoryPicker.displayName = 'WorkingDirectoryPicker';

export default WorkingDirectoryPicker;
