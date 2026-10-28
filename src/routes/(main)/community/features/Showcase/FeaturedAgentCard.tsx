'use client';

import { Avatar } from '@lobehub/ui';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import WorkspaceLink from '@/features/Workspace/WorkspaceLink';

// The design's four featured tints, each a 6% left-to-right wash.
const TINTS = [
  'linear-gradient(90deg, rgb(226 212 21 / 6%), rgb(235 137 0 / 6%))',
  'linear-gradient(90deg, rgb(226 72 21 / 6%), rgb(235 8 0 / 6%))',
  'linear-gradient(90deg, rgb(21 21 226 / 6%), rgb(86 0 235 / 6%))',
  'linear-gradient(90deg, rgb(21 144 226 / 6%), rgb(0 85 235 / 6%))',
];

const styles = stylex.create({
  author: {
    color: cssVar.colorTextTertiary,
    fontSize: 12,
    lineHeight: '20px',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  card: {
    alignItems: 'center',
    borderRadius: 12,
    color: 'inherit',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    height: 146,
    minWidth: 0,
    padding: 16,
    textAlign: 'center',
    textDecoration: 'none',
    transitionDuration: '0.15s',
    transitionProperty: 'filter',
  },
  hover: {
    filter: {
      'default': null,
      ':hover': 'brightness(0.98)',
    },
  },
  tint: (backgroundImage: string) => ({ backgroundImage }),
  title: {
    color: cssVar.colorText,
    fontSize: 14,
    fontWeight: 500,
    lineHeight: '22px',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

interface FeaturedAgentCardProps {
  author?: string;
  avatar?: string;
  backgroundColor?: string;
  index: number;
  onClick?: () => void;
  title: string;
  to: string;
}

/** A featured assistant: tinted card, centred 64px avatar, name and author. */
const FeaturedAgentCard = memo<FeaturedAgentCardProps>(
  ({ author, avatar, backgroundColor, index, onClick, title, to }) => {
    const { t } = useTranslation('discover');

    return (
      <WorkspaceLink
        data-testid={'featured-assistant'}
        title={title}
        to={to}
        onClick={(e) => {
          if (!onClick || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          onClick();
        }}
        {...stylex.props(styles.card, styles.hover, styles.tint(TINTS[index % TINTS.length]))}
      >
        <Avatar
          avatar={avatar}
          background={backgroundColor || 'transparent'}
          shape={'square'}
          size={64}
        />
        <span {...stylex.props(styles.title)}>{title}</span>
        {author && (
          <span {...stylex.props(styles.author)}>{t('showcase.author', { name: author })}</span>
        )}
      </WorkspaceLink>
    );
  },
);

FeaturedAgentCard.displayName = 'FeaturedAgentCard';

export default FeaturedAgentCard;
