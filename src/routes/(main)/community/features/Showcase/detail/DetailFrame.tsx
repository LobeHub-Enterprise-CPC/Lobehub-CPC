'use client';

import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { ArrowLeftIcon, type LucideIcon } from 'lucide-react';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import WorkspaceLink from '@/features/Workspace/WorkspaceLink';

import CopyPromptCard from './CopyPromptCard';

const styles = stylex.create({
  actions: {
    alignItems: 'center',
    display: 'flex',
    gap: 16,
    justifyContent: 'flex-end',
  },
  aside: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    position: 'sticky',
    top: 24,
  },
  body: {
    alignItems: 'start',
    display: 'grid',
    gap: 48,
    gridTemplateColumns: 'minmax(0, 1fr) 240px',
  },
  breadcrumb: {
    alignItems: 'center',
    color: cssVar.colorTextTertiary,
    display: 'flex',
    fontSize: 12,
    gap: 8,
    lineHeight: '20px',
  },
  breadcrumbLink: {
    alignItems: 'center',
    color: {
      'default': cssVar.colorTextTertiary,
      ':hover': cssVar.colorText,
    },
    display: 'inline-flex',
    gap: 16,
    textDecoration: 'none',
  },
  divider: {
    alignSelf: 'stretch',
    borderBlockEndColor: cssVar.colorBorderSecondary,
    borderBlockEndStyle: 'dashed',
    borderBlockEndWidth: 1,
    borderBlockStartWidth: 0,
    borderInlineWidth: 0,
    marginBlock: 0,
    width: '100%',
  },
  head: {
    alignItems: 'center',
    display: 'flex',
    gap: 24,
    minWidth: 0,
  },
  main: {
    display: 'flex',
    flexDirection: 'column',
    gap: 32,
    minWidth: 0,
  },
  meta: {
    color: cssVar.colorTextTertiary,
    fontSize: 12,
    lineHeight: '20px',
  },
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 24,
    marginInline: 'auto',
    maxWidth: 1208,
    paddingBlockStart: '32px',
    paddingBlockEnd: '48px',
    width: '100%',
  },
  tab: {
    alignItems: 'center',
    backgroundColor: {
      'default': 'transparent',
      ':hover': cssVar.colorFillTertiary,
    },
    borderRadius: 9999,
    borderWidth: 0,
    color: cssVar.colorText,
    cursor: 'pointer',
    display: 'inline-flex',
    fontSize: 16,
    gap: 8,
    height: 40,
    paddingInline: 20,
  },
  tabActive: {
    backgroundColor: {
      'default': `color-mix(in srgb, ${cssVar.colorPrimary} 8%, transparent)`,
      ':hover': `color-mix(in srgb, ${cssVar.colorPrimary} 12%, transparent)`,
    },
    color: cssVar.colorPrimary,
    fontWeight: 500,
  },
  tabs: {
    display: 'flex',
    gap: 16,
  },
  title: {
    color: cssVar.colorText,
    fontSize: 24,
    fontWeight: 600,
    lineHeight: '36px',
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  titleBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
  },
});

export interface DetailTab {
  icon: LucideIcon;
  key: string;
  label: ReactNode;
}

interface DetailFrameProps {
  activeTab: string;
  avatar?: ReactNode;
  children: ReactNode;
  install: ReactNode;
  kind: 'agent' | 'mcp' | 'skill';
  /** Author, category, last update: joined with middots under the title. */
  meta: (string | undefined)[];
  onTabChange: (key: string) => void;
  /** The text "copy prompt" puts on the clipboard. */
  prompt: string;
  /** The share action, beside the install button. */
  share?: ReactNode;
  tabs: DetailTab[];
  title: string;
}

/**
 * A showcase market detail page from the TITU Work design: breadcrumb back to
 * the list, identity header over a dashed rule, then the tabs with the page's
 * content, and on the right the share and install actions above the
 * "send the prompt to your AI" card.
 */
const DetailFrame = memo<DetailFrameProps>(
  ({
    activeTab,
    avatar,
    children,
    install,
    kind,
    meta,
    onTabChange,
    prompt,
    share,
    tabs,
    title,
  }) => {
    const { t } = useTranslation('discover');

    return (
      <div data-brand-slot={'community-detail'} {...stylex.props(styles.root)}>
        <div {...stylex.props(styles.breadcrumb)}>
          <WorkspaceLink to={`/community/${kind}`} {...stylex.props(styles.breadcrumbLink)}>
            <ArrowLeftIcon size={16} />
            {t(`showcase.tab.${kind}`)}
          </WorkspaceLink>
          <span>/</span>
          <span>{title}</span>
        </div>
        <div {...stylex.props(styles.head)}>
          {avatar}
          <div {...stylex.props(styles.titleBlock)}>
            <h1 {...stylex.props(styles.title)}>{title}</h1>
            <span {...stylex.props(styles.meta)}>{meta.filter(Boolean).join(' · ')}</span>
          </div>
        </div>
        <hr {...stylex.props(styles.divider)} />
        <div {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.main)}>
            <div role={'tablist'} {...stylex.props(styles.tabs)}>
              {tabs.map(({ icon: TabIcon, key, label }) => {
                const active = key === activeTab;
                return (
                  <button
                    aria-selected={active}
                    key={key}
                    role={'tab'}
                    type={'button'}
                    onClick={() => onTabChange(key)}
                    {...stylex.props(styles.tab, active && styles.tabActive)}
                  >
                    <TabIcon size={16} />
                    {label}
                  </button>
                );
              })}
            </div>
            {children}
          </div>
          <aside {...stylex.props(styles.aside)}>
            <div data-brand-slot={'community-detail-actions'} {...stylex.props(styles.actions)}>
              {share}
              {install}
            </div>
            <CopyPromptCard kind={kind} prompt={prompt} />
          </aside>
        </div>
      </div>
    );
  },
);

DetailFrame.displayName = 'DetailFrame';

export default DetailFrame;
