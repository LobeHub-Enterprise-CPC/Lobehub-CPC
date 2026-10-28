'use client';

import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { memo, type ReactNode } from 'react';

const styles = stylex.create({
  cell: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    minWidth: 0,
  },
  label: {
    color: cssVar.colorTextTertiary,
    fontSize: 14,
    lineHeight: '22px',
  },
  root: {
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: 12,
    borderStyle: 'solid',
    borderWidth: 1,
    display: 'grid',
    rowGap: '24px',
    columnGap: '16px',
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    padding: 16,
  },
  value: {
    color: cssVar.colorText,
    fontSize: 14,
    lineHeight: '22px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

/** Labelled facts in a four-column outlined grid (publisher, version, licence…). */
const InfoGrid = memo<{ items: { label: ReactNode; value?: ReactNode }[] }>(({ items }) => (
  <div {...stylex.props(styles.root)}>
    {items.map(({ label, value }, index) => (
      <div key={index} {...stylex.props(styles.cell)}>
        <span {...stylex.props(styles.label)}>{label}</span>
        <span {...stylex.props(styles.value)}>{value ?? '—'}</span>
      </div>
    ))}
  </div>
));

InfoGrid.displayName = 'InfoGrid';

export default InfoGrid;
