import type { BrandingColorScale, BrandingTheme } from '@lobechat/business-const';
import { generateColorNeutralPalette, generateColorPalette } from '@lobehub/ui';
import { darkAlgorithm } from '@lobehub/ui/es/styles/theme/algorithms/darkAlgorithm';
import { lightAlgorithm } from '@lobehub/ui/es/styles/theme/algorithms/lightAlgorithm';
import type { ThemeConfig } from 'antd';
import type { MapToken, SeedToken } from 'antd/es/theme/interface';

type Appearance = 'dark' | 'light';

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
  };
};

const neutralTokens = (scale: BrandingColorScale, appearance: Appearance) => ({
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
});

interface BrandAlgorithmOptions {
  appearance: Appearance;
  /** The user picked their own neutral colour: leave that family to lobe-ui. */
  skipNeutral?: boolean;
  /** The user picked their own primary colour: leave that family to lobe-ui. */
  skipPrimary?: boolean;
  theme: BrandingTheme;
}

/**
 * Builds the antd algorithm chain for one appearance: lobe-ui's own algorithm,
 * then a layer that replaces the primary and neutral families with the brand
 * scales.
 *
 * It has to be a layer rather than a token override. `theme.token.colorPrimary`
 * is a seed token, and lobe's algorithm rewrites the whole `colorPrimary` group
 * from its own scale afterwards — the value passed in never reaches a component.
 */
export const createBrandAlgorithm = ({
  appearance,
  skipNeutral,
  skipPrimary,
  theme,
}: BrandAlgorithmOptions): ThemeConfig['algorithm'] => {
  const base = appearance === 'dark' ? darkAlgorithm : lightAlgorithm;

  const brand = {
    ...(theme.primaryScale && !skipPrimary ? primaryTokens(theme.primaryScale, appearance) : {}),
    ...(theme.neutralScale && !skipNeutral ? neutralTokens(theme.neutralScale, appearance) : {}),
  };

  return [base, (_seed: SeedToken, map?: MapToken) => ({ ...map, ...brand }) as MapToken];
};
