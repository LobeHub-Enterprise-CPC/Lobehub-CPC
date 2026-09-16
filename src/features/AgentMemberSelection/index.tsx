import { Flexbox } from '@lobehub/ui';
import { Divider } from 'antd';
import { createStaticStyles } from 'antd-style';
import { type ReactNode } from 'react';

import type { AgentItemData } from './AgentItem';
import AvailableAgentList from './AvailableAgentList';
import SelectedAgentList from './SelectedAgentList';

const styles = createStaticStyles(({ css, cssVar }) => ({
  container: css`
    height: 500px;
    min-height: 0;
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
  `,
}));

/** The same member picker for Group Chat and Channel; each caller owns its selection. */
export function AgentMemberSelection({
  agents,
  disabled,
  existingMembers = [],
  isLoading = false,
  maxCount = Infinity,
  onChange,
  renderSelectedExtra,
  selectedAgentIds,
}: {
  agents: AgentItemData[];
  disabled?: boolean;
  existingMembers?: string[];
  isLoading?: boolean;
  maxCount?: number;
  onChange: (ids: string[]) => void;
  /** Extra controls under each selected row; omitted by Group Chat. */
  renderSelectedExtra?: (agent: AgentItemData) => ReactNode;
  selectedAgentIds: string[];
}) {
  const toggle = (id: string) => {
    if (disabled) return;
    if (selectedAgentIds.includes(id)) onChange(selectedAgentIds.filter((item) => item !== id));
    else if (
      selectedAgentIds.length < maxCount &&
      !agents.find((agent) => agent.id === id)?.disabled
    )
      onChange([...selectedAgentIds, id]);
  };
  return (
    <Flexbox horizontal className={styles.container} gap={8}>
      <AvailableAgentList
        agents={agents.filter((agent) => !existingMembers.includes(agent.id))}
        disabled={disabled}
        isLoading={isLoading}
        maxCount={maxCount}
        selectedAgentIds={selectedAgentIds}
        onToggle={toggle}
      />
      <Divider orientation="vertical" style={{ height: '100%' }} />
      <SelectedAgentList
        agents={agents}
        disabled={disabled}
        renderExtra={renderSelectedExtra}
        selectedAgentIds={selectedAgentIds}
        onToggle={toggle}
      />
    </Flexbox>
  );
}
