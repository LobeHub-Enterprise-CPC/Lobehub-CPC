import { ScrollShadow } from '@lobehub/ui';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useActiveLocation } from '@/hooks/useActiveLocation';

// NavItem is 36px and rows sit 1px apart, so N rows plus the 1px block padding
// on each side fill exactly N * 37 + 1. Used until the rows can be measured.
const ROW_HEIGHT = 36;
const ROW_GAP = 1;
const PADDING_BLOCK = 1;
// ScrollShadow fades this much of each scrolled edge.
const SHADOW_SIZE = 12;

// Every sidebar row (channel, thread, project, topic) renders through NavItem.
const ROW_SELECTOR = '[data-brand-slot="nav-item"]';

export const DEFAULT_VISIBLE_ROWS = 5;

export const getCappedNavListMaxHeight = (rows: number) =>
  rows * ROW_HEIGHT + (rows - 1) * ROW_GAP + PADDING_BLOCK * 2;

/**
 * Height that shows exactly `rows` rows of `container`, measured from the rows
 * themselves: wrappers around a row (a project group, a channel with threads)
 * can add a pixel or more, which a fixed row height would turn into a scroll
 * bar on a list that only has `rows` rows. `undefined` means no cap is needed;
 * `null` means the rows cannot be measured right now (a collapsed panel).
 */
export const measureCappedNavListHeight = (
  container: HTMLElement,
  rows: number,
): number | null | undefined => {
  const items = container.querySelectorAll<HTMLElement>(ROW_SELECTOR);
  if (items.length <= rows) return undefined;

  const bottom = items[rows - 1].getBoundingClientRect().bottom;
  const top = container.getBoundingClientRect().top - container.scrollTop;
  const height = Math.ceil(bottom - top + PADDING_BLOCK);
  return height > 0 ? height : null;
};

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
  const [maxHeight, setMaxHeight] = useState<number | undefined>(() =>
    getCappedNavListMaxHeight(rows),
  );

  // Rows arrive late (async topics), fold and unfold, and the panel itself can
  // open after mount, so re-measure whenever the content or the box changes.
  useLayoutEffect(() => {
    const container = ref.current;
    if (!container) return;

    const update = () => {
      const measured = measureCappedNavListHeight(container, rows);
      if (measured !== null) setMaxHeight(measured);
    };
    update();

    const mutations = new MutationObserver(update);
    mutations.observe(container, { childList: true, subtree: true });
    const resize = new ResizeObserver(update);
    resize.observe(container);
    return () => {
      mutations.disconnect();
      resize.disconnect();
    };
  }, [rows]);

  // A route can activate a row below the cap. Scroll only this list, never its
  // ancestors, so landing on the page does not also move the whole sidebar, and
  // clear the faded edge so the active row is not half-hidden under it.
  useEffect(() => {
    const container = ref.current;
    const row = container?.querySelector<HTMLElement>('[data-active]');
    if (!container || !row) return;

    const viewport = container.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < viewport.top + SHADOW_SIZE)
      container.scrollTop += rect.top - viewport.top - SHADOW_SIZE;
    else if (rect.bottom > viewport.bottom - SHADOW_SIZE)
      container.scrollTop += rect.bottom - viewport.bottom + SHADOW_SIZE;
  }, [pathname, search, ready, maxHeight]);

  return (
    <ScrollShadow
      gap={ROW_GAP}
      paddingBlock={PADDING_BLOCK}
      ref={ref}
      size={SHADOW_SIZE}
      style={{ maxHeight }}
    >
      {children}
    </ScrollShadow>
  );
};

export default CappedNavList;
