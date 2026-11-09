interface ThemeItem {
  displayName: string;
  id: string;
}

/** The house theme both `highlighterThemes` and `mermaidThemes` list first. */
export const DEFAULT_THEME_ID = 'lobe-theme';

/**
 * Select options for a theme list from `@lobehub/ui`.
 *
 * The library names its house theme "Lobe Theme" without going through
 * translation, so the brand rewrite never sees it. It is the default setting,
 * so it is labelled as such; the stored value stays `lobe-theme`.
 */
export const toThemeOptions = (themes: readonly ThemeItem[]) =>
  themes.map((item) => ({
    label: item.id === DEFAULT_THEME_ID ? 'Default' : item.displayName,
    value: item.id,
  }));
