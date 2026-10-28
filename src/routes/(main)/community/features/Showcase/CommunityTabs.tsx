'use client';

import { SkillsIcon } from '@lobehub/ui/icons';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { BotIcon, PlugIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { brandIcon } from '@/components/BrandIcon';
import WorkspaceLink from '@/features/Workspace/WorkspaceLink';
import { usePathname } from '@/libs/router/navigation';

const styles = stylex.create({
  active: {
    backgroundColor: cssVar.colorPrimary,
    color: cssVar.colorTextLightSolid,
    fontWeight: 600,
  },
  root: {
    alignItems: 'center',
    display: 'flex',
    gap: 8,
  },
  tab: {
    alignItems: 'center',
    backgroundColor: {
      'default': 'transparent',
      ':hover': cssVar.colorFillTertiary,
    },
    borderRadius: 9999,
    color: cssVar.colorText,
    display: 'flex',
    fontSize: 16,
    gap: 8,
    height: 40,
    lineHeight: '24px',
    paddingInline: 16,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  },
  tabActive: {
    backgroundColor: {
      'default': cssVar.colorPrimary,
      ':hover': cssVar.colorPrimaryHover,
    },
  },
});

const TABS = [
  { icon: brandIcon('community.agent', BotIcon), key: 'agent', label: 'showcase.tab.agent' },
  { icon: brandIcon('community.skill', SkillsIcon), key: 'skill', label: 'showcase.tab.skill' },
  { icon: brandIcon('community.mcp', PlugIcon), key: 'mcp', label: 'showcase.tab.mcp' },
] as const;

/**
 * The three kinds of the showcase market as the top bar's leading tabs: the
 * current kind is a filled pill, the others plain text with their icon.
 */
const CommunityTabs = memo(() => {
  const { t } = useTranslation('discover');
  const pathname = usePathname();
  const active = pathname.split('/')[2] || 'agent';

  return (
    <nav aria-label={t('showcase.nav')} {...stylex.props(styles.root)}>
      {TABS.map(({ icon: TabIcon, key, label }) => {
        const isActive = active === key;
        return (
          <WorkspaceLink
            aria-current={isActive ? 'page' : undefined}
            key={key}
            to={`/community/${key}`}
            {...stylex.props(styles.tab, isActive && styles.tabActive, isActive && styles.active)}
          >
            <TabIcon size={16} />
            {t(label as any)}
          </WorkspaceLink>
        );
      })}
    </nav>
  );
});

CommunityTabs.displayName = 'CommunityTabs';

export default CommunityTabs;
