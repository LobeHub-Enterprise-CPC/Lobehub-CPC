import { Flexbox, Icon, Popover, Tooltip } from '@lobehub/ui';
import { cssVar, cx } from 'antd-style';
import {
  ChevronDownIcon,
  FolderIcon,
  InfinityIcon,
  MessageCircleIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useBusinessAgentModeSync } from '@/business/client/hooks/useBusinessAgentMode';
import { useAgentId } from '@/features/ChatInput/hooks/useAgentId';
import { useChatInputResourceAccess } from '@/features/ChatInput/hooks/useChatInputResourceAccess';
import { useEffectiveAgentMode } from '@/features/ChatInput/hooks/useEffectiveAgentMode';
import { useToggleAgentMode } from '@/features/ChatInput/hooks/useToggleAgentMode';
import { usePermission } from '@/hooks/usePermission';

import { styles } from './modeSelectorStyles';

const AGENT_CAPS = [
  { icon: WrenchIcon, key: 'tools' },
  { icon: SearchIcon, key: 'web' },
  { icon: FolderIcon, key: 'files' },
  { icon: TerminalIcon, key: 'env' },
] as const;

const ModeSelector = memo(() => {
  const { t } = useTranslation('chat');
  const agentId = useAgentId();
  const toggleAgentMode = useToggleAgentMode();
  useBusinessAgentModeSync(agentId);
  const [open, setOpen] = useState(false);
  const { allowed: canCreateContent, reason } = usePermission('create_content');
  // Agent/Chat mode is a caller runtime preference for ordinary Workspace
  // members; only members who cannot use the Agent are disabled.
  const { canUseResource, isGroupContext } = useChatInputResourceAccess();
  const disabled = !canCreateContent || !canUseResource;
  const disabledReason = !canCreateContent
    ? reason
    : t(isGroupContext ? 'input.viewOnlyGroup' : 'input.viewOnlyAgent');

  const { canSelectAgentMode, currentMode, isAgentModeUnavailable, isPreferenceLoading } =
    useEffectiveAgentMode(agentId);
  const CurrentIcon = currentMode === 'agent' ? InfinityIcon : MessageCircleIcon;

  const handleSelect = useCallback(
    async (mode: 'chat' | 'agent') => {
      if (disabled) return;
      if (mode === 'agent' && !canSelectAgentMode) return;

      setOpen(false);
      await toggleAgentMode(mode === 'agent');
    },
    [disabled, canSelectAgentMode, toggleAgentMode],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (disabled) return;

      setOpen(nextOpen);
    },
    [disabled],
  );

  const agentTooltip = (
    <div className={styles.agentTooltip}>
      <div className={styles.agentTooltipTitle}>{t('chatMode.agent')}</div>
      {AGENT_CAPS.map(({ key, icon }) => (
        <div className={styles.agentTooltipCap} key={key}>
          <Icon icon={icon} size={12} />
          {t(`chatMode.agentCap.${key}`)}
        </div>
      ))}
    </div>
  );

  const chatTooltip = t('chatMode.chatDesc');
  const buttonTooltip = isAgentModeUnavailable
    ? t('chatMode.agentUnsupported')
    : currentMode === 'agent'
      ? agentTooltip
      : chatTooltip;
  const agentDesc = canSelectAgentMode ? t('chatMode.agentDesc') : t('chatMode.agentUnsupported');

  const popoverContent = (
    <Flexbox gap={4} style={{ maxWidth: 320, minWidth: 280 }}>
      <Flexbox
        horizontal
        align="center"
        gap={12}
        className={cx(
          styles.option,
          currentMode === 'agent' && styles.activeOption,
          !canSelectAgentMode && styles.optionDisabled,
        )}
        onClick={() => handleSelect('agent')}
      >
        <Flexbox
          align="center"
          className={styles.optionIcon}
          height={32}
          justify="center"
          width={32}
        >
          <Icon icon={InfinityIcon} size={16} />
        </Flexbox>
        <Flexbox flex={1}>
          <div className={styles.optionTitle}>{t('chatMode.agent')}</div>
          <div className={styles.optionDesc}>{agentDesc}</div>
        </Flexbox>
      </Flexbox>

      <Flexbox
        horizontal
        align="center"
        className={cx(styles.option, currentMode === 'chat' && styles.activeOption)}
        gap={12}
        onClick={() => handleSelect('chat')}
      >
        <Flexbox
          align="center"
          className={styles.optionIcon}
          height={32}
          justify="center"
          width={32}
        >
          <Icon icon={MessageCircleIcon} size={16} />
        </Flexbox>
        <Flexbox flex={1}>
          <div className={styles.optionTitle}>{t('chatMode.chat')}</div>
          <div className={styles.optionDesc}>{t('chatMode.chatDesc')}</div>
        </Flexbox>
      </Flexbox>
    </Flexbox>
  );

  const button = (
    <div className={cx(styles.button, disabled && styles.buttonDisabled)}>
      <Icon icon={CurrentIcon} size={14} />
      <span>{t(`chatMode.${currentMode}`)}</span>
      <Icon icon={ChevronDownIcon} size={12} />
    </div>
  );

  if (isPreferenceLoading) return null;

  if (disabled)
    return (
      <Tooltip title={disabledReason}>
        <div>{button}</div>
      </Tooltip>
    );

  return (
    <Popover
      className={styles.popoverPopup}
      content={popoverContent}
      open={!disabled && open}
      placement="topLeft"
      trigger="click"
      styles={{
        // Match the inner viewport's corner to the enlarged popup radius so its
        // border corners don't poke through the rounded popup.
        content: {
          border: `1px solid ${cssVar.colorBorderSecondary}`,
          borderRadius: cssVar.borderRadiusLG,
          padding: 4,
        },
      }}
      onOpenChange={handleOpenChange}
    >
      <div>{open ? button : <Tooltip title={buttonTooltip}>{button}</Tooltip>}</div>
    </Popover>
  );
});

ModeSelector.displayName = 'ModeSelector';

export default ModeSelector;
