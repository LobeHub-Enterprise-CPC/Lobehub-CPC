'use client';

import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { type LucideIcon } from 'lucide-react';
import { memo, type ReactNode } from 'react';

const styles = stylex.create({
  count: {
    color: cssVar.colorTextTertiary,
    fontWeight: 400,
  },
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  title: {
    alignItems: 'center',
    color: cssVar.colorText,
    display: 'flex',
    fontSize: 14,
    fontWeight: 600,
    gap: 8,
    lineHeight: '22px',
    margin: 0,
  },
});

/** One block of a detail tab: icon, title and optional count, then its content. */
const DetailSection = memo<{
  children?: ReactNode;
  count?: number;
  icon: LucideIcon;
  title: ReactNode;
}>(({ children, count, icon: SectionIcon, title }) => (
  <section {...stylex.props(styles.root)}>
    <h2 {...stylex.props(styles.title)}>
      <SectionIcon size={16} />
      {title}
      {count !== undefined && <span {...stylex.props(styles.count)}>{count}</span>}
    </h2>
    {children}
  </section>
));

DetailSection.displayName = 'DetailSection';

export default DetailSection;
