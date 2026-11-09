import { DEFAULT_COMMON_SETTINGS } from '@lobechat/const';
import { highlighterThemes, mermaidThemes } from '@lobehub/ui';
import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME_ID, toThemeOptions } from './themeOptions';

describe('toThemeOptions', () => {
  it.each([
    ['highlighter', highlighterThemes, DEFAULT_COMMON_SETTINGS.highlighterTheme],
    ['mermaid', mermaidThemes, DEFAULT_COMMON_SETTINGS.mermaidTheme],
  ])('labels the default %s theme "Default" and keeps its stored value', (_, themes, current) => {
    const options = toThemeOptions(themes);

    // The default setting must still point at an option the list offers.
    expect(current).toBe(DEFAULT_THEME_ID);
    expect(options).toContainEqual({ label: 'Default', value: DEFAULT_THEME_ID });
    expect(options.map((option) => option.label)).not.toContain('Lobe Theme');
  });

  it('keeps the library display name for every other theme', () => {
    const others = highlighterThemes.filter((item) => item.id !== DEFAULT_THEME_ID);

    expect(toThemeOptions(highlighterThemes)).toEqual([
      { label: 'Default', value: DEFAULT_THEME_ID },
      ...others.map((item) => ({ label: item.displayName, value: item.id })),
    ]);
  });
});
