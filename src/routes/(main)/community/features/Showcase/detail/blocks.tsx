'use client';

import { Tag } from '@lobehub/ui';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import dayjs from 'dayjs';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export const blockStyles = stylex.create({
  bordered: {
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: 12,
    borderStyle: 'solid',
    borderWidth: 1,
    color: cssVar.colorText,
    fontSize: 14,
    lineHeight: '22px',
    paddingBlock: 12,
    paddingInline: 16,
  },
  cardDesc: {
    WebkitBoxOrient: 'vertical',
    WebkitLineClamp: 2,
    color: cssVar.colorTextTertiary,
    display: '-webkit-box',
    fontSize: 12,
    lineHeight: '20px',
    overflow: 'hidden',
  },
  cardTitle: {
    color: cssVar.colorText,
    fontSize: 14,
    fontWeight: 500,
    lineHeight: '22px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  grid2: {
    display: 'grid',
    gap: 12,
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  },
  grid3: {
    display: 'grid',
    gap: 12,
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  },
  // Markdown keeps its own spacing; the tinted block only frames it.
  markdown: {
    paddingBlock: 16,
    whiteSpace: 'normal',
  },
  muted: {
    color: cssVar.colorTextTertiary,
    fontSize: 14,
    lineHeight: '22px',
    margin: 0,
  },
  numbered: {
    alignItems: 'center',
    display: 'flex',
    gap: 16,
  },
  number: {
    color: cssVar.colorTextTertiary,
  },
  tinted: {
    backgroundColor: cssVar.colorFillQuaternary,
    borderRadius: 12,
    color: cssVar.colorText,
    fontSize: 14,
    lineHeight: '22px',
    paddingBlock: 12,
    paddingInline: 16,
    whiteSpace: 'pre-wrap',
  },
  text: {
    color: cssVar.colorText,
    fontSize: 14,
    lineHeight: '22px',
    margin: 0,
    whiteSpace: 'pre-wrap',
  },
  tileCard: {
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: 12,
    borderStyle: 'solid',
    borderWidth: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
    padding: 16,
  },
});

/** A titled tile: name over a two-line description (tools, prompts, skills). */
export const Tile = memo<{ description?: string; extra?: ReactNode; title: string }>(
  ({ description, extra, title }) => (
    <div {...stylex.props(blockStyles.tileCard)}>
      <span {...stylex.props(blockStyles.cardTitle)}>
        {extra}
        {title}
      </span>
      {description && <span {...stylex.props(blockStyles.cardDesc)}>{description}</span>}
    </div>
  ),
);

const versionStyles = stylex.create({
  date: {
    color: cssVar.colorTextSecondary,
    fontSize: 14,
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  row: {
    alignItems: 'center',
    display: 'flex',
    gap: 8,
    justifyContent: 'space-between',
  },
  version: {
    alignItems: 'center',
    display: 'flex',
    gap: 8,
  },
});

/** Version history: each release on its own row, the latest marked. */
export const VersionList = memo<{
  versions: { createdAt?: string; isLatest?: boolean; version: string }[];
}>(({ versions }) => {
  const { t } = useTranslation('discover');

  return (
    <div {...stylex.props(versionStyles.list)}>
      {versions.map((item, index) => (
        <div key={item.version} {...stylex.props(blockStyles.bordered, versionStyles.row)}>
          <span {...stylex.props(versionStyles.version)}>
            {t('showcase.detail.version', { version: `v${item.version.split('.')[0]}` })}
            {(item.isLatest ?? index === 0) && (
              <Tag color={'info'} size={'small'}>
                {t('showcase.detail.latestVersion')}
              </Tag>
            )}
          </span>
          {item.createdAt && (
            <span {...stylex.props(versionStyles.date)}>
              {t('showcase.detail.publishedAt', {
                date: dayjs(item.createdAt).format(t('showcase.detail.dateFormat')),
              })}
            </span>
          )}
        </div>
      ))}
    </div>
  );
});
