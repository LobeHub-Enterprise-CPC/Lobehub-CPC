import { CodeIcon, SquareTerminalIcon } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { GenericCategoryIcon, resolveCategoryIcon } from './categoryIcon';

describe('resolveCategoryIcon', () => {
  it('maps lucide:<name> through the static table', () => {
    expect(resolveCategoryIcon('lucide:code')).toBe(CodeIcon);
    expect(resolveCategoryIcon('lucide:square-terminal')).toBe(SquareTerminalIcon);
  });

  it.each([
    null,
    undefined,
    '',
    'lucide:not-an-icon',
    'lucide:constructor',
    'data:image/png;base64,AAAA',
    'ftp://x/y.png',
  ])('falls back to the generic icon for %s', (icon) => {
    expect(resolveCategoryIcon(icon)).toBe(GenericCategoryIcon);
  });

  it('renders an HTTP(S) URL as an image icon, one component per URL', () => {
    const icon = resolveCategoryIcon('https://cdn.example.com/a.webp');

    expect(icon).not.toBe(GenericCategoryIcon);
    expect(resolveCategoryIcon('https://cdn.example.com/a.webp')).toBe(icon);
    expect(resolveCategoryIcon('HTTP://cdn.example.com/b.webp')).not.toBe(icon);
  });
});
