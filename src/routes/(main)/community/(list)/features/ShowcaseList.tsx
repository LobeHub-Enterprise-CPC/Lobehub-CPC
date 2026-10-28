'use client';

import * as stylex from '@stylexjs/stylex';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { gridStyles } from '../../features/Showcase/grid';
import SectionHeader from '../../features/Showcase/SectionHeader';
import SortButton from './SortButton';

const styles = stylex.create({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 32,
    width: '100%',
  },
});

interface ShowcaseListProps {
  children: ReactNode;
  /** The featured row, already laid out; omitted when there is nothing to feature. */
  featured?: ReactNode;
  footer?: ReactNode;
  title?: ReactNode;
}

/**
 * A showcase market list: the featured row first, then the full list under
 * its own title with the sort control beside it.
 */
const ShowcaseList = memo<ShowcaseListProps>(({ children, featured, footer, title }) => {
  const { t } = useTranslation('discover');

  return (
    <div {...stylex.props(styles.root)}>
      {featured && (
        <section {...stylex.props(gridStyles.section)}>
          <SectionHeader title={t('showcase.featured')} />
          {featured}
        </section>
      )}
      <section {...stylex.props(gridStyles.section)}>
        <SectionHeader extra={<SortButton />} title={title ?? t('showcase.all')} />
        {children}
      </section>
      {footer}
    </div>
  );
});

ShowcaseList.displayName = 'ShowcaseList';

export default ShowcaseList;
