import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import CappedNavList, { DEFAULT_VISIBLE_ROWS, getCappedNavListMaxHeight } from './CappedNavList';

vi.mock('@/hooks/useActiveLocation', () => ({
  useActiveLocation: () => ({ pathname: '/channels/c8', search: '' }),
}));

afterEach(cleanup);

const rect = (top: number, height: number) => ({ bottom: top + height, height, top }) as DOMRect;

describe('CappedNavList', () => {
  // Five 36px rows with 1px gaps plus 1px padding on each side: exactly five
  // rows fit, so a list of five never shows a scrollbar.
  it('fits exactly the default five rows', () => {
    expect(DEFAULT_VISIBLE_ROWS).toBe(5);
    expect(getCappedNavListMaxHeight(5)).toBe(186);
  });

  it('caps its height at the visible rows', () => {
    const { container } = render(
      <CappedNavList rows={3}>
        <div />
      </CappedNavList>,
    );

    expect((container.firstElementChild as HTMLElement).style.maxHeight).toBe(
      `${getCappedNavListMaxHeight(3)}px`,
    );
  });

  // Landing on a channel below the cap must not leave its row hidden.
  it('scrolls only itself to bring the active row into view', () => {
    const spy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.active ? rect(300, 36) : rect(0, 186);
      });

    const { container } = render(
      <CappedNavList ready={8}>
        <div data-active="true" />
      </CappedNavList>,
    );

    expect((container.firstElementChild as HTMLElement).scrollTop).toBe(150);
    spy.mockRestore();
  });
});
