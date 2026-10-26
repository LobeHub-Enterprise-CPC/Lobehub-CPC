'use client';

import { Flexbox, Icon } from '@lobehub/ui';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { FolderClosedIcon, FolderOpenIcon, FolderPlusIcon, type LucideIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { openPickWorkingDirModal } from '@/features/WorkingDirectory';
import { electronSystemService } from '@/services/electron/system';

const styles = stylex.create({
  chooseFolderItem: {
    backgroundColor: {
      'default': 'transparent',
      ':hover': cssVar.colorFillTertiary,
    },
    borderRadius: cssVar.borderRadius,
    color: {
      'default': cssVar.colorTextSecondary,
      ':hover': cssVar.colorText,
    },
    cursor: 'pointer',
    fontSize: 13,
    paddingBlock: 8,
    paddingInline: 8,
    transitionDuration: '0.2s',
    transitionProperty: 'background-color, color',
  },
  quiet: {
    backgroundColor: {
      'default': 'transparent',
      ':hover': cssVar.colorFillTertiary,
    },
    borderRadius: cssVar.borderRadiusLG,
    color: {
      'default': cssVar.colorTextTertiary,
      ':hover': cssVar.colorText,
    },
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: '20px',
    paddingBlock: 10,
    paddingInline: 12,
    transitionDuration: '0.2s',
    transitionProperty: 'background-color, color',
  },
});

export type FolderEntry = { path: string; repoType?: 'git' | 'github' };

interface ChooseLocalFolderRowProps {
  defaultPath?: string;
  onPick: (entry: FolderEntry) => void;
  /** `quiet` is the place picker's tertiary row. The default matches the chip menu. */
  tone?: 'default' | 'quiet';
}

/** This machine: browse the filesystem via the native Electron folder dialog. */
export const ChooseLocalFolderRow = memo<ChooseLocalFolderRowProps>(
  ({ defaultPath, onPick, tone = 'default' }) => {
    const { t } = useTranslation('device');
    const icon: LucideIcon = tone === 'quiet' ? FolderClosedIcon : FolderOpenIcon;
    const handleClick = async () => {
      const result = await electronSystemService.selectFolder({
        defaultPath: defaultPath || undefined,
        title: t('workingDirectory.selectFolder'),
      });
      if (result) onPick({ path: result.path, repoType: result.repoType });
    };
    return (
      <Flexbox
        horizontal
        align={'center'}
        data-testid={'choose-local-folder'}
        gap={8}
        onClick={handleClick}
        {...stylex.props(tone === 'quiet' ? styles.quiet : styles.chooseFolderItem)}
      >
        <Icon icon={icon} size={14} />
        <span>{t('workingDirectory.chooseDifferentFolder')}</span>
      </Flexbox>
    );
  },
);
ChooseLocalFolderRow.displayName = 'ChooseLocalFolderRow';

interface AddRemoteFolderRowProps {
  defaultCwd?: string;
  deviceId?: string;
  onBeforeOpen: () => void;
  onPick: (entry: FolderEntry) => void;
  tone?: 'default' | 'quiet';
}

/** Browse the target device through its directory RPC. */
export const AddRemoteFolderRow = memo<AddRemoteFolderRowProps>(
  ({ defaultCwd, deviceId, onBeforeOpen, onPick, tone = 'default' }) => {
    const { t } = useTranslation('device');
    const icon: LucideIcon = tone === 'quiet' ? FolderClosedIcon : FolderPlusIcon;

    const handleClick = () => {
      onBeforeOpen();
      openPickWorkingDirModal({ defaultPath: defaultCwd || undefined, deviceId, onPick });
    };
    return (
      <Flexbox
        horizontal
        align={'center'}
        data-testid={'add-remote-folder'}
        gap={8}
        onClick={handleClick}
        {...stylex.props(tone === 'quiet' ? styles.quiet : styles.chooseFolderItem)}
      >
        <Icon icon={icon} size={14} />
        <span>
          {tone === 'quiet'
            ? t('workingDirectory.chooseDifferentFolder')
            : t('workingDirectory.addFolder')}
        </span>
      </Flexbox>
    );
  },
);
AddRemoteFolderRow.displayName = 'AddRemoteFolderRow';
