'use client';

import { AGENT_PROFILE_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { getActivePluginIds } from '@lobechat/types';
import { Button, Flexbox, Text } from '@lobehub/ui';
import isEqual from 'fast-deep-equal';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useActiveWorkspaceId } from '@/business/client/hooks/useActiveWorkspaceId';
import type { AgentToolProps } from '@/features/ProfileEditor/AgentTool';
import SharedAgentTool from '@/features/ProfileEditor/AgentTool';
import PluginTag from '@/features/ProfileEditor/PluginTag';
import { getVisibleProfileToolIds } from '@/features/ProfileEditor/profileToolVisibility';
import { useAgentStore } from '@/store/agent';
import { agentSelectors } from '@/store/agent/selectors';
import { useToolStore } from '@/store/tool';
import { builtinToolSelectors } from '@/store/tool/selectors';
import { connectorSelectors } from '@/store/tool/slices/connector';

interface Props extends AgentToolProps {
  agentId: string;
  copying: boolean;
  copyMode: boolean;
  onCancelCopy: () => void;
  onConfirmCopy: () => void;
  selected: Set<string>;
  toggleSelected: (id: string) => void;
}

/**
 * The "User Tools" section (bottom of the tools area). Normally the user's
 * pinned tools (SharedAgentTool). In copy mode, the user's connectors become
 * selectable chips so several can be copied into the agent at once.
 */
const UserToolsSection = memo<Props>(
  ({
    agentId,
    copyMode,
    copying,
    onCancelCopy,
    onConfirmCopy,
    selected,
    toggleSelected,
    ...toolProps
  }) => {
    const { t } = useTranslation('setting');
    const userConnectors = useToolStore(connectorSelectors.connectorList, isEqual);
    const config = useAgentStore(agentSelectors.getAgentConfigById(agentId), isEqual);
    const isManualSkillMode = config?.chatConfig?.skillActivateMode === 'manual';
    // Agent-owned/linked connector identifiers are shown in the Agent Tools
    // section above (and excluded from this section's chips in `AgentTool`), so
    // exclude them from the count too — otherwise the header would count a tool
    // that renders in the section above, not here.
    const agentConnectors = useToolStore(connectorSelectors.agentConnectors(agentId), isEqual);
    const agentConnectorIdentifiers = useMemo(
      () => new Set(agentConnectors.map((c) => c.identifier)),
      [agentConnectors],
    );
    const nonProfileConfigurableBuiltinToolIds = useToolStore(
      builtinToolSelectors.nonProfileConfigurableBuiltinToolIds({
        isManualMode: isManualSkillMode,
      }),
      isEqual,
    );
    const nonProfileConfigurableBuiltinToolIdentifiers = useMemo(
      () => new Set(nonProfileConfigurableBuiltinToolIds),
      [nonProfileConfigurableBuiltinToolIds],
    );
    const userToolCount = getVisibleProfileToolIds(getActivePluginIds(config?.plugins), {
      agentConnectorIdentifiers,
      nonConfigurableBuiltinToolIdentifiers: nonProfileConfigurableBuiltinToolIdentifiers,
    }).length;
    // In a workspace, this section's base tools are the WORKSPACE dimension
    // (`connector.list` is workspace-scoped), not the caller's personal tools —
    // label it so the user knows the tools are shared workspace-scoped, not
    // their private ones. Personal mode keeps the "User Tools" label.
    const activeWorkspaceId = useActiveWorkspaceId();
    const baseToolsLabel = activeWorkspaceId
      ? t('settingAgent.agentTools.tabWorkspace')
      : t('settingAgent.agentTools.tabUser');

    // Copyable = the user's own base connectors (not agent-owned, not mounted).
    const copyable = userConnectors.filter((c) => !c.agentId && !c.metadata?.mountedByAgentId);

    const confirmCopyButton = (
      <Button
        disabled={selected.size === 0 || copying}
        loading={copying}
        size={'small'}
        type={'primary'}
        onClick={onConfirmCopy}
      >
        {t('settingAgent.agentTools.copyConfirm', { count: selected.size })}
      </Button>
    );

    if (copyMode) {
      const copyActions = (
        <Flexbox horizontal gap={8}>
          {AGENT_PROFILE_SHOWCASE_LAYOUT && confirmCopyButton}
          <Button disabled={copying} size={'small'} type={'text'} onClick={onCancelCopy}>
            {t('cancel', { ns: 'common' })}
          </Button>
          {!AGENT_PROFILE_SHOWCASE_LAYOUT && confirmCopyButton}
        </Flexbox>
      );

      // The showcase layout reads top to bottom — hint, the tools to pick,
      // then the decision — so the confirm sits under what it applies to.
      return (
        <Flexbox
          data-brand-slot={'agent-tools-copy-panel'}
          gap={AGENT_PROFILE_SHOWCASE_LAYOUT ? 12 : 8}
        >
          <Flexbox horizontal align={'center'} justify={'space-between'}>
            <Text style={{ fontSize: 12 }} type={'secondary'}>
              {t('settingAgent.agentTools.copyPick')}
            </Text>
            {!AGENT_PROFILE_SHOWCASE_LAYOUT && copyActions}
          </Flexbox>
          <Flexbox horizontal align={'center'} gap={8} wrap={'wrap'}>
            {copyable.length === 0 && (
              <Text style={{ fontSize: 12 }} type={'secondary'}>
                {t('settingAgent.agentTools.pickerEmpty')}
              </Text>
            )}
            {copyable.map((c) => (
              <PluginTag
                selectable
                key={c.id}
                pluginId={c.identifier}
                selected={selected.has(c.id)}
                onSelect={() => toggleSelected(c.id)}
              />
            ))}
          </Flexbox>
          {AGENT_PROFILE_SHOWCASE_LAYOUT && copyActions}
        </Flexbox>
      );
    }

    return (
      <Flexbox data-brand-slot={'agent-user-tools'} gap={AGENT_PROFILE_SHOWCASE_LAYOUT ? 12 : 8}>
        <Text
          data-brand-slot={'agent-config-label'}
          style={{ fontSize: 12, fontWeight: 500 }}
          type={'secondary'}
        >
          {baseToolsLabel} · {userToolCount}
        </Text>
        <SharedAgentTool
          {...toolProps}
          excludeAgentConnectors
          agentId={agentId}
          showAuthor={!!activeWorkspaceId}
        />
      </Flexbox>
    );
  },
);

UserToolsSection.displayName = 'UserToolsSection';

export default UserToolsSection;
