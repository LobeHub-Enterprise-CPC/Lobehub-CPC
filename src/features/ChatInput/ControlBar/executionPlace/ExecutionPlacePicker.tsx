'use client';

import { isDesktop } from '@lobechat/const';
import type { WorkingDirEntry } from '@lobechat/types';
import { Flexbox, Icon, Popover, type PopoverProps, Tooltip } from '@lobehub/ui';
import * as stylex from '@stylexjs/stylex';
import { CloudIcon, GlobeIcon, LaptopIcon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatLockedControlTooltip } from '@/features/ChatInput/utils/lockedControlTooltip';

import { ExecutionTargetDeviceList } from '../ExecutionTargetDeviceList';
import type { FolderEntry } from '../folderRows';
import { useExecutionTargetController } from '../useExecutionTargetController';
import { useWorkingDirectoryController } from '../useWorkingDirectoryController';
import { ExecutionPlaceDirectoryPanel } from './ExecutionPlaceDirectoryPanel';
import { ExecutionPlaceMenu } from './ExecutionPlaceMenu';
import { type ExecutionPlace, resolveExecutionPlace } from './resolveExecutionPlace';
import { styles } from './style';

type Side = 'local' | 'remote' | null;

// Each cascade level is its own card, so the popup shell itself stays bare.
// lobe-ui leaves `style` out of the popupProps type but forwards it to the popup.
const barePopupProps = {
  style: { backgroundColor: 'transparent', boxShadow: 'none' },
} as PopoverProps['popupProps'];

export interface ExecutionPlacePickerProps {
  agentId: string;
  /** Members who can run but not edit the agent may switch place, not the directory. */
  allowDirectory?: boolean;
  /**
   * Side the cascade (working directory or remote devices) opens on. `left`
   * right-aligns the menu with the trigger, `right` left-aligns it.
   */
  placement?: 'left' | 'right';
}

const placeIcon = {
  cloud: CloudIcon,
  local: LaptopIcon,
  remote: GlobeIcon,
} as const;

export const ExecutionPlacePicker = memo<ExecutionPlacePickerProps>(
  ({ agentId, allowDirectory = true, placement = 'right' }) => {
    const { t } = useTranslation(['chat', 'device']);
    const model = useExecutionTargetController(agentId);
    const directory = useWorkingDirectoryController(agentId, model.open);
    const place = resolveExecutionPlace({
      localSandboxEnabled: model.localSandboxEnabled,
      target: model.chipExecutionTarget,
    });
    const [side, setSide] = useState<Side>(null);

    if (!model.canShowExecutionTarget) return null;

    const placeLabel = t(`heteroAgent.executionPlace.${place}`);
    const directoryPath = place === 'cloud' ? undefined : directory.selectedDir || undefined;
    const tooltip = !model.canShowExecutionTargetSelector
      ? formatLockedControlTooltip(placeLabel, t('heteroAgent.executionTarget.fixedTip'))
      : directoryPath
        ? `${placeLabel} · ${directoryPath}`
        : placeLabel;

    const openSide = (next: ExecutionPlace): Side => {
      if (next === 'remote') return 'remote';
      // Web cannot run or browse a folder on this computer.
      if (next === 'local' && allowDirectory && isDesktop) return 'local';
      return null;
    };

    const handleOpenChange = (next: boolean) => {
      model.setOpen(next);
      setSide(next ? openSide(place) : null);
    };

    const close = () => handleOpenChange(false);

    const chooseLocal = () => {
      if (!isDesktop) return;
      setSide(allowDirectory ? 'local' : null);
      if (model.executionTarget !== 'local') void model.selectTarget('local');
    };

    const chooseCloud = () => {
      if (!model.supportsSandbox) return;
      close();
      if (model.executionTarget !== 'sandbox') void model.selectTarget('sandbox');
    };

    const chooseRemote = () => setSide('remote');

    const commitDirectory = async (entry: WorkingDirEntry | FolderEntry) => {
      const onLocalPanel = side === 'local';
      if (onLocalPanel && model.executionTarget !== 'local') {
        await model.selectTarget('local');
        await directory.commit(entry, { localTarget: true });
      } else {
        await directory.commit(entry);
      }
      close();
    };

    const showLocalDirectory = allowDirectory && side === 'local';
    const showRemoteDevices = side === 'remote';
    const showRemoteDirectory =
      allowDirectory &&
      side === 'remote' &&
      model.executionTarget === 'device' &&
      !!model.boundDeviceId;

    const trigger = (
      <button
        aria-expanded={model.open}
        aria-haspopup={model.canShowExecutionTargetSelector ? 'menu' : undefined}
        aria-label={placeLabel}
        data-place={place}
        data-readonly={model.canShowExecutionTargetSelector ? 'false' : 'true'}
        data-testid={'execution-place-trigger'}
        type={'button'}
        {...stylex.props(
          styles.trigger,
          model.open && styles.triggerOpen,
          !model.canShowExecutionTargetSelector && styles.triggerReadonly,
        )}
      >
        <Icon icon={placeIcon[place]} size={16} />
      </button>
    );

    if (!model.canShowExecutionTargetSelector) {
      return <Tooltip title={tooltip}>{trigger}</Tooltip>;
    }

    const sidePanel = showLocalDirectory ? (
      <ExecutionPlaceDirectoryPanel
        isLocal
        deviceDefaultCwd={directory.deviceDefaultCwd}
        hasClearableSelection={directory.hasClearableSelection}
        recents={directory.recents}
        selectedDir={directory.selectedDir}
        targetDeviceId={directory.targetDeviceId}
        onClear={() => void directory.clear().then(close)}
        onClose={close}
        onPick={(entry) => void commitDirectory(entry)}
      />
    ) : showRemoteDevices ? (
      <>
        <Flexbox data-testid={'execution-place-devices'} gap={4} {...stylex.props(styles.panel)}>
          <ExecutionTargetDeviceList
            emptyVariant={'panel'}
            model={model}
            onSelectDevice={(deviceId) => {
              if (!(model.executionTarget === 'device' && model.boundDeviceId === deviceId)) {
                void model.selectTarget('device', deviceId);
              }
            }}
          />
        </Flexbox>
        {/* The chosen device's folders are the third level, its own card. */}
        {showRemoteDirectory ? (
          <ExecutionPlaceDirectoryPanel
            deviceDefaultCwd={directory.deviceDefaultCwd}
            hasClearableSelection={directory.hasClearableSelection}
            isLocal={false}
            recents={directory.recents}
            selectedDir={directory.selectedDir}
            targetDeviceId={directory.targetDeviceId}
            onClear={() => void directory.clear().then(close)}
            onClose={close}
            onPick={(entry) => void commitDirectory(entry)}
          />
        ) : null}
      </>
    ) : null;

    // The popup stays as wide as the menu; the cascade levels are laid out
    // beside it, each the menu's width and height, so opening one never moves
    // the menu.
    const content = (
      <div {...stylex.props(styles.popup)}>
        {sidePanel ? (
          <div
            data-placement={placement}
            data-testid={'execution-place-side'}
            {...stylex.props(
              styles.side,
              placement === 'left' ? styles.sideLeft : styles.sideRight,
            )}
          >
            {sidePanel}
          </div>
        ) : null}
        <ExecutionPlaceMenu
          localDisabled={!isDesktop}
          model={model}
          place={place}
          showDesktopDownload={model.showDesktopDownload}
          onCloud={chooseCloud}
          onHover={(next) => setSide(openSide(next))}
          onLocal={chooseLocal}
          onRemote={chooseRemote}
        />
      </div>
    );

    return (
      // Keep the anchor tree stable across open changes: the Popover trigger
      // element must stay the same button, otherwise Base UI remounts the
      // anchor on the opening click and the popup needs a second click.
      // The tooltip is forced shut while the menu is open instead of being
      // unmounted from the tree.
      <Tooltip open={model.open ? false : undefined} title={tooltip}>
        <Popover
          arrow={false}
          content={content}
          open={model.open}
          placement={placement === 'left' ? 'topRight' : 'topLeft'}
          popupProps={barePopupProps}
          trigger={'click'}
          styles={{
            content: {
              background: 'transparent',
              boxShadow: 'none',
              overflow: 'visible',
              padding: 0,
            },
          }}
          onOpenChange={handleOpenChange}
        >
          {trigger}
        </Popover>
      </Tooltip>
    );
  },
);

ExecutionPlacePicker.displayName = 'ExecutionPlacePicker';
