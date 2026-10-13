'use client';

import { Button, Popover, Text } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { ChevronsUpDownIcon } from 'lucide-react';
import { memo, useState } from 'react';

import Avatar from '@/components/Avatar';
import { useFetchAgentList } from '@/hooks/useFetchAgentList';
import { agentService } from '@/services/agent';
import { useAgentStore } from '@/store/agent';
import { useGlobalStore } from '@/store/global';

import AgentList from './AgentList';
import { useHomeAgentDisplay } from './useHomeAgentDisplay';

const styles = createStaticStyles(({ css, cssVar }) => ({
  chevron: css`
    color: ${cssVar.colorTextDescription};
    opacity: 0;
    transition: opacity 0.2s ${cssVar.motionEaseOut};
  `,
  name: css`
    font-size: 14px;
    line-height: 20px;
  `,
  trigger: css`
    gap: 8px;
    justify-content: flex-start;

    width: fit-content;
    min-width: 0;
    max-width: 100%;
    height: auto;
    margin-inline-start: -2px;
    padding: 2px;
    border: 0;

    background: transparent;

    &:hover .agent-select-chevron,
    &[data-popup-open] .agent-select-chevron {
      opacity: 1;
    }

    &[data-popup-open] {
      background: ${cssVar.colorFillTertiary};
    }
  `,
}));

const AgentSelect = memo(() => {
  const [open, setOpen] = useState(false);
  const { error, mutate } = useFetchAgentList();
  const updateSystemStatus = useGlobalStore((s) => s.updateSystemStatus);
  const {
    agentId: displayAgentId,
    avatar: displayAvatar,
    backgroundColor,
    title: displayTitle,
  } = useHomeAgentDisplay();

  const handleSelect = (agentId: string) => {
    updateSystemStatus({ homeSelectedAgentId: agentId });
    setOpen(false);

    const agentState = useAgentStore.getState();
    if (agentState.agentMap[agentId]) return;

    agentService
      .getAgentConfigById(agentId)
      .then((config) => {
        if (config) agentState.internal_dispatchAgentMap(agentId, config);
      })
      .catch((error) => console.error('[AgentSelect] failed to prefetch agent config', error));
  };

  return (
    <Popover
      classNames={{ trigger: styles.trigger }}
      open={open}
      placement={'bottomLeft'}
      styles={{ content: { padding: 0, width: 360 } }}
      trigger={'click'}
      content={
        <AgentList
          activeAgentId={displayAgentId}
          error={error}
          onRetry={() => mutate()}
          onSelect={handleSelect}
        />
      }
      onOpenChange={setOpen}
    >
      <Button
        aria-expanded={open}
        aria-haspopup={'dialog'}
        data-brand-slot={'home-agent-select'}
        type={'text'}
      >
        <Avatar
          avatar={displayAvatar}
          background={backgroundColor}
          name={displayTitle}
          shape={'square'}
          size={24}
        />
        <Text ellipsis className={styles.name} style={{ minWidth: 0 }} weight={600}>
          {displayTitle}
        </Text>
        <ChevronsUpDownIcon className={`${styles.chevron} agent-select-chevron`} size={12} />
      </Button>
    </Popover>
  );
});

export default AgentSelect;
