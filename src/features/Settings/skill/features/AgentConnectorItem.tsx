'use client';

import { getComposioAppByIdentifier, getLobehubSkillProviderById } from '@lobechat/const';
import { Avatar, cssVar, Flexbox, Icon, Tag } from '@lobehub/ui';
import { McpIcon } from '@lobehub/ui/icons';
import { memo } from 'react';

import RevokedTag from '@/features/MarketAssetAccess/RevokedTag';
import NavItem from '@/features/NavPanel/components/NavItem';
import { useRevokedMarketAssets } from '@/hooks/useRevokedMarketAssets';
import type { AgentBoundConnector } from '@/store/tool/slices/connector/types';

/**
 * A row in the unified settings' "Agent Connectors" section.
 *
 * Rendered identically to the base connector rows (same NavItem + the same brand
 * icon a base Composio/LobeHub connector of this identifier would show), so the
 * only visual difference is a tag naming the owning agent. Selectable — clicking
 * routes to the shared ConnectorDetail on the right, keyed by connector id to
 * avoid the identifier collision an agent connector can have with a base one.
 */
const AgentConnectorItem = memo<{
  connector: AgentBoundConnector;
  isSelected?: boolean;
  onSelect?: () => void;
}>(({ connector, isSelected, onSelect }) => {
  // An agent's copy of a Market connector stops working with the base install when the
  // enterprise no longer makes it available, so it carries the same mark.
  const revokedMarketAssets = useRevokedMarketAssets();
  const revoked =
    connector.sourceType === 'marketplace' && revokedMarketAssets.has(connector.identifier);
  // Resolve the same brand icon a base connector of this identifier would use;
  // fall back to the generic MCP icon for custom/unknown connectors.
  const brand =
    getComposioAppByIdentifier(connector.identifier) ??
    getLobehubSkillProviderById(connector.identifier);

  const renderIcon = () => {
    if (brand) {
      const { icon, label } = brand;
      if (typeof icon === 'string') return <Avatar alt={label} avatar={icon} size={18} />;
      return <Icon fill={cssVar.colorText} icon={icon} size={18} />;
    }
    return <Icon icon={McpIcon} size={18} />;
  };

  return (
    <NavItem
      active={isSelected}
      icon={renderIcon}
      title={brand?.label || connector.name || connector.identifier}
      extra={
        connector.agentTitle || revoked ? (
          <Flexbox horizontal gap={4}>
            {connector.agentTitle && <Tag size="small">{connector.agentTitle}</Tag>}
            {revoked && <RevokedTag />}
          </Flexbox>
        ) : undefined
      }
      onClick={onSelect}
    />
  );
});

AgentConnectorItem.displayName = 'AgentConnectorItem';

export default AgentConnectorItem;
