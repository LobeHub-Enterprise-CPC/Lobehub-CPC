'use client';

import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { memo, type ReactNode } from 'react';

import WorkspaceLink from '@/features/Workspace/WorkspaceLink';

const styles = stylex.create({
  body: {
    display: 'flex',
    flex: '1',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
  },
  card: {
    backgroundColor: cssVar.colorBgContainer,
    borderColor: {
      'default': cssVar.colorBorderSecondary,
      ':hover': cssVar.colorBorder,
    },
    borderRadius: 12,
    borderStyle: 'solid',
    borderWidth: 1,
    color: 'inherit',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    height: '100%',
    minWidth: 0,
    padding: 16,
    textDecoration: 'none',
    transitionDuration: '0.15s',
    transitionProperty: 'border-color, box-shadow',
  },
  desc: {
    WebkitBoxOrient: 'vertical',
    color: cssVar.colorTextSecondary,
    display: '-webkit-box',
    fontSize: 12,
    lineHeight: '20px',
    margin: 0,
    overflow: 'hidden',
  },
  descRows2: { WebkitLineClamp: 2 },
  descRows3: { WebkitLineClamp: 3 },
  elevated: {
    borderColor: 'transparent',
    boxShadow: {
      'default': cssVar.boxShadowTertiary,
      ':hover': cssVar.boxShadowSecondary,
    },
  },
  head: {
    alignItems: 'flex-start',
    display: 'flex',
    gap: 12,
    minWidth: 0,
  },
  subtitle: {
    color: cssVar.colorTextTertiary,
    fontSize: 12,
    lineHeight: '20px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  tag: {
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: 6,
    borderStyle: 'solid',
    borderWidth: 1,
    color: cssVar.colorTextTertiary,
    flex: 'none',
    fontSize: 10,
    fontWeight: 500,
    lineHeight: '18px',
    paddingInline: 6,
    whiteSpace: 'nowrap',
  },
  title: {
    color: cssVar.colorText,
    fontSize: 14,
    fontWeight: 500,
    lineHeight: '22px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  titleRow: {
    alignItems: 'center',
    display: 'flex',
    gap: 8,
    minWidth: 0,
  },
  // A lone title is centred on the 32px icon; with a second line it sits on top.
  titleRowAlone: {
    minHeight: 32,
  },
});

export interface ShowcaseCardProps {
  avatar: ReactNode;
  /** Category label, drawn as a small outlined tag at the top right. */
  category?: ReactNode;
  description?: string;
  /** Lines of description to keep before clamping. */
  descriptionRows?: 2 | 3;
  /** A raised card without outline, for a featured row. */
  elevated?: boolean;
  /** Between the head and the description: counts such as tools or prompts. */
  meta?: ReactNode;
  onClick?: () => void;
  subtitle?: ReactNode;
  testId?: string;
  title: string;
  to: string;
}

/**
 * A market card from the TITU Work design: icon or avatar, name (and an
 * optional second line), the category as a small tag on the right, then a
 * clamped description. The whole card is the link.
 */
const ShowcaseCard = memo<ShowcaseCardProps>(
  ({
    avatar,
    category,
    description,
    descriptionRows = 2,
    elevated,
    meta,
    onClick,
    subtitle,
    testId,
    title,
    to,
  }) => (
    <WorkspaceLink
      data-brand-slot={'community-card'}
      data-testid={testId}
      title={title}
      to={to}
      onClick={(e) => {
        if (!onClick || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onClick();
      }}
      {...stylex.props(styles.card, elevated && styles.elevated)}
    >
      <div {...stylex.props(styles.head)}>
        <div style={{ flex: 'none' }}>{avatar}</div>
        <div {...stylex.props(styles.body)}>
          <div {...stylex.props(styles.titleRow, !subtitle && styles.titleRowAlone)}>
            <span {...stylex.props(styles.title)}>{title}</span>
          </div>
          {subtitle && <span {...stylex.props(styles.subtitle)}>{subtitle}</span>}
        </div>
        {category && <span {...stylex.props(styles.tag)}>{category}</span>}
      </div>
      {meta}
      {description && (
        <p
          {...stylex.props(
            styles.desc,
            descriptionRows === 3 ? styles.descRows3 : styles.descRows2,
          )}
        >
          {description}
        </p>
      )}
    </WorkspaceLink>
  ),
);

ShowcaseCard.displayName = 'ShowcaseCard';

export default ShowcaseCard;
