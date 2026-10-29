import { CodeIcon, CompassIcon, LayoutPanelTopIcon, PencilIcon } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import type { AssetCategoryItem } from '@/types/discover';

import { GenericCategoryIcon } from './categoryIcon';
import { type DiscoverCategoryItem, mergeCategories } from './mergeCategories';

const local: DiscoverCategoryItem[] = [
  { icon: CompassIcon, key: 'discover', label: 'Discover' },
  { icon: LayoutPanelTopIcon, key: 'all', label: 'All' },
  { icon: PencilIcon, key: 'copywriting', label: 'Copywriting' },
  { icon: CodeIcon, key: 'programming', label: 'Programming' },
];

const category = (overrides: Partial<AssetCategoryItem>): AssetCategoryItem => ({
  count: 0,
  description: '',
  icon: null,
  identifier: 'x',
  localizations: {},
  name: 'X',
  sortOrder: 0,
  ...overrides,
});

const remote = [
  category({
    count: 5,
    icon: 'lucide:code',
    identifier: 'programming',
    name: '编程',
    sortOrder: 20,
  }),
  category({
    count: 0,
    description: '法务与合规',
    icon: null,
    identifier: 'legal',
    name: '法务',
    sortOrder: 10,
  }),
];

describe('mergeCategories', () => {
  it('keeps the pseudo entries and lists Market categories in sortOrder with their names', () => {
    const items = mergeCategories({ local, remote });

    expect(items.map((item) => item.key)).toEqual(['discover', 'all', 'legal', 'programming']);
    expect(items.map((item) => item.label)).toEqual(['Discover', 'All', '法务', '编程']);
    expect(items[2]).toMatchObject({ count: 0, icon: GenericCategoryIcon, title: '法务与合规' });
    expect(items[3]).toMatchObject({ count: 5, icon: CodeIcon, title: undefined });
  });

  it('breaks sortOrder ties by identifier', () => {
    const items = mergeCategories({
      local,
      remote: [
        category({ identifier: 'zeta', sortOrder: 1 }),
        category({ identifier: 'alpha', sortOrder: 1 }),
      ],
    });

    expect(items.slice(2).map((item) => item.key)).toEqual(['alpha', 'zeta']);
  });

  it('sums the Market counts into "all" and leaves "discover" without one', () => {
    const items = mergeCategories({ local, remote });

    expect(items.find((item) => item.key === 'all')?.count).toBe(5);
    expect(items.find((item) => item.key === 'discover')?.count).toBeUndefined();
  });

  it('takes the query-aware counts by identifier while searching', () => {
    const items = mergeCategories({
      counts: [
        { category: 'programming', count: 2 },
        { category: 'unknown', count: 9 },
      ],
      local,
      remote,
      searching: true,
    });

    expect(items.find((item) => item.key === 'programming')?.count).toBe(2);
    expect(items.find((item) => item.key === 'legal')?.count).toBeUndefined();
    expect(items.find((item) => item.key === 'all')?.count).toBe(2);
  });

  it('ignores a pseudo identifier coming from Market', () => {
    const items = mergeCategories({
      local,
      remote: [category({ identifier: 'all', name: 'Everything' }), ...remote],
    });

    expect(items.filter((item) => item.key === 'all')).toHaveLength(1);
    expect(items.find((item) => item.key === 'all')?.label).toBe('All');
  });

  it('falls back to a label from the identifier when Market sends no name', () => {
    const items = mergeCategories({ local, remote: [category({ identifier: 'legal', name: '' })] });

    expect(items.at(-1)?.label).toBe('legal');
  });

  it.each([
    ['unread or failed', undefined],
    ['empty', []],
  ])('keeps the built-in list when the Market directory is %s', (_, directory) => {
    const items = mergeCategories({
      counts: [
        { category: 'copywriting', count: 3 },
        { category: 'programming', count: 4 },
      ],
      local,
      remote: directory,
    });

    expect(items.map((item) => item.key)).toEqual(local.map((item) => item.key));
    expect(items.map((item) => item.label)).toEqual(local.map((item) => item.label));
    expect(items.map((item) => item.count)).toEqual([undefined, 7, 3, 4]);
  });

  it('leaves every count unknown when no counts are available', () => {
    const items = mergeCategories({ local });

    expect(items.every((item) => item.count === undefined)).toBe(true);
  });
});
