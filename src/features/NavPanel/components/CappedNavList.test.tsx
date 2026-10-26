import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import CappedNavList, {
  DEFAULT_VISIBLE_ROWS,
  getCappedNavListMaxHeight,
  measureCappedNavListHeight,
} from './CappedNavList';

vi.mock('@/hooks/useActiveLocation', () => ({
  useActiveLocation: () => ({ pathname: '/channels/c8', search: '' }),
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    disconnect() {}
    observe() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const rect = (top: number, height: number) => ({ bottom: top + height, height, top }) as DOMRect;

/**
 * Lay rows out as the browser would: 1px padding, then each row `rowHeight`
 * tall with a 1px gap. The container itself starts at 0.
 */
const layoutRows = (rowHeight: number) =>
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const index = this.dataset.row;
    if (index === undefined) return rect(0, 186);
    return rect(1 + Number(index) * (rowHeight + 1), rowHeight);
  });

const rowsOf = (count: number) =>
  Array.from({ length: count }, (_, index) => (
    <div data-brand-slot="nav-item" data-row={index} key={index} />
  ));

describe('CappedNavList', () => {
  // Five 36px rows with 1px gaps plus 1px padding on each side: exactly five
  // rows fit, so a list of five never shows a scrollbar.
  it('falls back to exactly five 36px rows before measuring', () => {
    expect(DEFAULT_VISIBLE_ROWS).toBe(5);
    expect(getCappedNavListMaxHeight(5)).toBe(186);
  });

  // Project groups render 37px rows; a fixed 186px cap scrolled a list of five.
  it('measures the cap from the rows themselves', () => {
    layoutRows(37);
    const { container } = render(<div>{rowsOf(8)}</div>);

    // 1 + 5 * 37 + 4 * 1 + 1 = 191: all five rows, no partial sixth.
    expect(measureCappedNavListHeight(container.firstElementChild as HTMLElement, 5)).toBe(191);
  });

  it('applies no cap when the list fits', () => {
    layoutRows(37);
    const { container } = render(<CappedNavList>{rowsOf(5)}</CappedNavList>);

    expect((container.firstElementChild as HTMLElement).style.maxHeight).toBe('');
  });

  it('caps a longer list at the measured five rows', () => {
    layoutRows(37);
    const { container } = render(<CappedNavList>{rowsOf(8)}</CappedNavList>);

    expect((container.firstElementChild as HTMLElement).style.maxHeight).toBe('191px');
  });

  // Landing on a channel below the cap must not leave its row hidden or faded.
  it('scrolls only itself to bring the active row clear of the faded edge', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      // The row moves up as its list scrolls, as it does in a browser.
      const scrolled = this.parentElement?.scrollTop ?? 0;
      return this.dataset.active ? rect(300 - scrolled, 36) : rect(0, 186);
    });

    const { container } = render(
      <CappedNavList ready={8}>
        <div data-active="true" />
      </CappedNavList>,
    );

    // Row bottom 336, list bottom 186, plus the 12px fade.
    expect((container.firstElementChild as HTMLElement).scrollTop).toBe(162);
  });
});
