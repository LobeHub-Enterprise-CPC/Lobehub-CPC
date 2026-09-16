'use client';

import { agentDisplayName } from '@lobechat/types';
import { Flexbox } from '@lobehub/ui';
import { Avatar, Checkbox, Text } from '@lobehub/ui/base-ui';
import { useHover } from 'ahooks';
import { createStaticStyles } from 'antd-style';
import { X } from 'lucide-react';
import { memo, useRef } from 'react';

import { DEFAULT_AVATAR } from '@/const/meta';

const styles = createStaticStyles(({ css, cssVar }) => ({
  item: css`
    cursor: pointer;

    margin-block: 1px;
    padding-block: 6px;
    padding-inline: 8px;
    border-radius: ${cssVar.borderRadius};

    transition: background 0.2s ease;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  removeButton: css`
    cursor: pointer;

    display: flex;
    align-items: center;
    justify-content: center;

    width: 20px;
    height: 20px;
    padding: 0;
    border: 0;
    border-radius: 4px;

    color: ${cssVar.colorTextTertiary};

    background: transparent;

    transition: all 0.2s ease;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillSecondary};
    }
  `,
  title: css`
    overflow: hidden;
    flex: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

export interface AgentItemData {
  avatar: string | null;
  backgroundColor: string | null;
  description: string | null;
  disabled?: boolean;
  id: string;
  /** Short trailing label explaining the row's state, e.g. why it is disabled. */
  status?: string;
  title: string | null;
}

interface AgentItemProps {
  agent: AgentItemData;
  defaultTitle: string;
  disabled?: boolean;
  isSelected?: boolean;
  onToggle: (id: string) => void;
  showCheckbox?: boolean;
  showRemove?: boolean;
}

const AgentItem = memo<AgentItemProps>(
  ({ agent, defaultTitle, disabled, isSelected, onToggle, showCheckbox, showRemove }) => {
    const ref = useRef(null);
    const isHovering = useHover(ref);

    const title = agentDisplayName(agent, defaultTitle);
    const avatar = agent.avatar || DEFAULT_AVATAR;
    const avatarBackground = agent.backgroundColor ?? undefined;

    const handleClick = () => {
      if (!disabled) onToggle(agent.id);
    };

    const handleRemove = (e: { stopPropagation: () => void }) => {
      e.stopPropagation();
      handleClick();
    };

    return (
      <div
        className={styles.item}
        ref={ref}
        style={{
          cursor: disabled ? 'not-allowed' : showCheckbox ? 'pointer' : 'default',
          opacity: disabled ? 0.5 : undefined,
        }}
        onClick={showCheckbox ? handleClick : undefined}
      >
        <Flexbox horizontal align="center" gap={8} width="100%">
          {showCheckbox && (
            <Checkbox
              aria-label={title}
              checked={isSelected}
              disabled={disabled}
              onChange={handleClick}
              onClick={(e) => {
                e.stopPropagation();
              }}
            />
          )}
          <Avatar
            animation={isHovering}
            avatar={avatar}
            background={avatarBackground}
            shape="circle"
            size={28}
          />
          <Text ellipsis className={styles.title}>
            {title}
          </Text>
          {agent.status && (
            <Text fontSize={12} style={{ flexShrink: 0 }} type="secondary">
              {agent.status}
            </Text>
          )}
          {showRemove && (
            <button
              aria-label={title}
              className={styles.removeButton}
              disabled={disabled}
              type="button"
              onClick={handleRemove}
            >
              <X size={14} />
            </button>
          )}
        </Flexbox>
      </div>
    );
  },
);

export default AgentItem;
