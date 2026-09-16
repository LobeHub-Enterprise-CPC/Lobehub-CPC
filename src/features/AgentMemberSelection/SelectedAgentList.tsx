'use client';

import { Flexbox } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { type ReactNode } from 'react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import AgentSelectionEmpty from '@/features/AgentSelectionEmpty';

import { type AgentItemData } from './AgentItem';
import AgentItem from './AgentItem';

const styles = createStaticStyles(({ css, cssVar }) => ({
  container: css`
    overflow-y: auto;
    flex: 1;
    padding: ${cssVar.paddingSM}px;
  `,
  title: css`
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
  `,
  extra: css`
    /* Line up with the row title: item padding + avatar + gap. */
    padding-block: 0 8px;
    padding-inline: 44px 8px;
  `,
}));

interface SelectedAgentListProps {
  agents: AgentItemData[];
  disabled?: boolean;
  onToggle: (id: string) => void;
  /** Extra controls shown under a selected row, e.g. where a Channel member runs. */
  renderExtra?: (agent: AgentItemData) => ReactNode;
  selectedAgentIds: string[];
}

const SelectedAgentList = memo<SelectedAgentListProps>(
  ({ agents, disabled, onToggle, renderExtra, selectedAgentIds }) => {
    const { t } = useTranslation(['chat', 'common']);

    const defaultTitle = useMemo(() => t('defaultSession', { ns: 'common' }), [t]);

    // Get selected agents data
    const selectedAgents = useMemo(() => {
      return selectedAgentIds
        .map((id) => agents.find((a) => a.id === id))
        .filter((a): a is AgentItemData => a !== undefined);
    }, [agents, selectedAgentIds]);

    if (selectedAgents.length === 0) {
      return (
        <Flexbox className={styles.container} flex={1}>
          <AgentSelectionEmpty variant="noSelected" />
        </Flexbox>
      );
    }

    return (
      <Flexbox className={styles.container} gap={4}>
        <div className={styles.title}>
          {t('memberSelection.selectedAgents', { count: selectedAgents.length })}
        </div>
        <Flexbox>
          {selectedAgents.map((agent) => {
            const extra = renderExtra?.(agent);
            return (
              <Flexbox key={agent.id}>
                <AgentItem
                  showRemove
                  agent={agent}
                  defaultTitle={defaultTitle}
                  disabled={disabled}
                  onToggle={onToggle}
                />
                {extra && <div className={styles.extra}>{extra}</div>}
              </Flexbox>
            );
          })}
        </Flexbox>
      </Flexbox>
    );
  },
);

export default SelectedAgentList;
