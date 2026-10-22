import type { BrandingColorScale, BrandingTheme } from '@lobechat/business-const';
import { generateColorNeutralPalette, generateColorPalette } from '@lobehub/ui';

type Appearance = 'light' | 'dark';

/**
 * A saturated brand hue does two jobs. Solid roles are button backgrounds
 * carrying `colorTextLightSolid`, so they stay dark enough for a light label in
 * both appearances. Text roles sit on a surface, so in the dark appearance they
 * have to be light enough to read against it.
 */
const brandRoles = (scale: BrandingColorScale, appearance: Appearance) => {
  const step = scale[appearance];
  const isDark = appearance === 'dark';
  return {
    solid: step[9],
    solidActive: isDark ? step[6] : step[11],
    solidHover: isDark ? step[7] : step[10],
    text: isDark ? step[10] : step[9],
    textActive: isDark ? step[10] : step[11],
    textHover: isDark ? step[11] : step[10],
  };
};

const primaryTokens = (scale: BrandingColorScale, appearance: Appearance) => {
  const role = brandRoles(scale, appearance);
  return {
    ...generateColorPalette({ appearance, scale, type: 'Primary' }),
    ...generateColorPalette({ appearance, scale, type: 'Info' }),
    // Info and link take the brand hue too, otherwise a second, nearly
    // identical blue sits beside the brand one.
    colorInfo: role.solid,
    colorInfoActive: role.solidActive,
    colorInfoHover: role.solidHover,
    colorInfoText: role.text,
    colorInfoTextActive: role.textActive,
    colorInfoTextHover: role.textHover,
    colorLink: role.text,
    colorLinkActive: role.textActive,
    colorLinkHover: role.textHover,
    colorPrimary: role.solid,
    colorPrimaryActive: role.solidActive,
    colorPrimaryHover: role.solidHover,
    colorPrimaryText: role.text,
    colorPrimaryTextActive: role.textActive,
    colorPrimaryTextHover: role.textHover,
    // The primary stays a saturated solid in both appearances, so its label
    // stays light.
    colorTextLightSolid: '#ffffff',
  } as Record<string, string>;
};

const neutralTokens = (scale: BrandingColorScale, appearance: Appearance) =>
  ({
    ...generateColorNeutralPalette({ appearance, scale }),
    // generateColorNeutralPalette maps colorBorderSecondary to the same step as
    // colorBgElevated in the dark appearance, so hairlines vanish. Paper alphas
    // read on every surface without lifting the page.
    ...(appearance === 'dark'
      ? {
          colorBorder: scale.darkA[4],
          colorBorderSecondary: scale.darkA[3],
          colorSplit: scale.darkA[3],
        }
      : {}),
  }) as Record<string, string>;

/** `colorPrimaryHover` → `--lobe-color-primary-hover`, the variable theme.css reads. */
const toCssVar = (token: string) =>
  `--lobe-${token.replaceAll(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;

const declare = (tokens: Record<string, string>) =>
  Object.entries(tokens)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([token, value]) => `  ${toCssVar(token)}: ${value};`)
    .join('\n');

interface BrandThemeCssOptions {
  /** The user picked their own neutral colour: leave that family to lobe-ui. */
  skipNeutral?: boolean;
  /** The user picked their own primary colour: leave that family to lobe-ui. */
  skipPrimary?: boolean;
}

/**
 * lobe-ui v6 dropped the antd `ThemeProvider`/algorithm chain: colours are
 * `--lobe-color-*` CSS variables switched by `[data-theme]`. A distribution's
 * brand scales therefore have to be published as variables rather than handed
 * to an algorithm — same tokens, same roles, emitted per appearance.
 *
 * Returns an empty string when the distribution ships no brand scales, so the
 * caller can drop the injected stylesheet and fall back to lobe-ui defaults.
 */
export const buildBrandThemeCss = (
  theme: BrandingTheme | undefined,
  { skipNeutral, skipPrimary }: BrandThemeCssOptions = {},
): string => {
  if (!theme) return '';

  const blocks: string[] = [];
  for (const appearance of ['light', 'dark'] as const) {
    const tokens = {
      ...(theme.primaryScale && !skipPrimary ? primaryTokens(theme.primaryScale, appearance) : {}),
      ...(theme.neutralScale && !skipNeutral ? neutralTokens(theme.neutralScale, appearance) : {}),
    };
    const body = declare(tokens);
    if (!body) continue;

    blocks.push(
      appearance === 'light'
        ? `:root, [data-theme='light'] {\n${body}\n}`
        : `[data-theme='dark'] {\n${body}\n}`,
    );
  }

  return blocks.join('\n');
};
