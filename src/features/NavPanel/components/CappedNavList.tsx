import { ScrollShadow } from '@lobehub/ui';
import { type ReactNode, useEffect, useRef } from 'react';

import { useActiveLocation } from '@/hooks/useActiveLocation';

// NavItem is 36px and rows sit 1px apart, so N rows plus the 1px block padding
// on each side fill exactly N * 37 + 1.
const ROW_HEIGHT = 36;
const ROW_GAP = 1;
const PADDING_BLOCK = 1;

export const DEFAULT_VISIBLE_ROWS = 5;

export const getCappedNavListMaxHeight = (rows: number) =>
  rows * ROW_HEIGHT + (rows - 1) * ROW_GAP + PADDING_BLOCK * 2;

interface CappedNavListProps {
  children: ReactNode;
  /**
   * Changes once the async rows have mounted (e.g. the item count), so a route
   * restored on load still brings its row into view.
   */
  ready?: unknown;
  rows?: number;
}

/**
 * A sidebar section capped at a few rows; the rest scroll inside the section
 * instead of pushing the sections below it off-screen.
 */
const CappedNavList = ({ children, ready, rows = DEFAULT_VISIBLE_ROWS }: CappedNavListProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const { pathname, search } = useActiveLocation();

  // A route can activate a row below the cap. Scroll only this list, never its
  // ancestors, so landing on the page does not also move the whole sidebar.
  useEffect(() => {
    const container = ref.current;
    const row = container?.querySelector<HTMLElement>('[data-active]');
    if (!container || !row) return;

    const viewport = container.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < viewport.top) container.scrollTop += rect.top - viewport.top;
    else if (rect.bottom > viewport.bottom) container.scrollTop += rect.bottom - viewport.bottom;
  }, [pathname, search, ready]);

  return (
    <ScrollShadow
      gap={ROW_GAP}
      paddingBlock={PADDING_BLOCK}
      ref={ref}
      size={12}
      style={{ maxHeight: getCappedNavListMaxHeight(rows) }}
    >
      {children}
    </ScrollShadow>
  );
};

export default CappedNavList;
