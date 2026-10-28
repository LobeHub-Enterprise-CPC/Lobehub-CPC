'use client';

import { SkillsIcon } from '@lobehub/ui/icons';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { MessageSquareQuoteIcon, PackageIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { brandIcon } from '@/components/BrandIcon';

const styles = stylex.create({
  item: {
    alignItems: 'center',
    display: 'inline-flex',
    gap: 4,
  },
  root: {
    alignItems: 'center',
    color: cssVar.colorTextTertiary,
    display: 'flex',
    fontSize: 12,
    gap: 12,
    lineHeight: '20px',
  },
});

const ToolsIcon = brandIcon('community.skill', SkillsIcon);
const PromptsIcon = brandIcon('community.prompts', MessageSquareQuoteIcon);
const ResourcesIcon = brandIcon('community.resources', PackageIcon);

/** A connector's tool, prompt and resource counts, each beside its icon. */
const ConnectorStats = memo<{
  promptsCount?: number;
  resourcesCount?: number;
  toolsCount?: number;
}>(({ promptsCount = 0, resourcesCount = 0, toolsCount = 0 }) => {
  const { t } = useTranslation('discover');

  return (
    <div {...stylex.props(styles.root)}>
      <span title={t('showcase.detail.builtinSkills')} {...stylex.props(styles.item)}>
        <ToolsIcon size={14} />
        {toolsCount}
      </span>
      <span title={t('showcase.detail.prompts')} {...stylex.props(styles.item)}>
        <PromptsIcon size={14} />
        {promptsCount}
      </span>
      <span title={t('showcase.detail.resources')} {...stylex.props(styles.item)}>
        <ResourcesIcon size={14} />
        {resourcesCount}
      </span>
    </div>
  );
});

ConnectorStats.displayName = 'ConnectorStats';

export default ConnectorStats;
