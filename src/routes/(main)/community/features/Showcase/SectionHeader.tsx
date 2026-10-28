'use client';

import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { memo, type ReactNode } from 'react';

const styles = stylex.create({
  root: {
    alignItems: 'center',
    display: 'flex',
    justifyContent: 'space-between',
    minHeight: 22,
  },
  title: {
    color: cssVar.colorText,
    fontSize: 14,
    fontWeight: 600,
    lineHeight: '22px',
    margin: 0,
  },
});

/** A market list section: its title on the left, an action (sort) on the right. */
const SectionHeader = memo<{ extra?: ReactNode; title: ReactNode }>(({ extra, title }) => (
  <div {...stylex.props(styles.root)}>
    <h2 {...stylex.props(styles.title)}>{title}</h2>
    {extra}
  </div>
));

SectionHeader.displayName = 'SectionHeader';

export default SectionHeader;
