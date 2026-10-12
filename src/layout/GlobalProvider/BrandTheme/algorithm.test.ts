import type { BrandingColorRamp, BrandingColorScale } from '@lobechat/business-const';
import { describe, expect, it } from 'vitest';

import { createBrandAlgorithm } from './algorithm';

const ramp = (prefix: string) =>
  Array.from({ length: 13 }, (_, index) => `${prefix}${index}`) as BrandingColorRamp;

const scale = (name: string): BrandingColorScale => ({
  dark: ramp(`${name}-dark-`),
  darkA: ramp(`${name}-darkA-`),
  light: ramp(`${name}-light-`),
  lightA: ramp(`${name}-lightA-`),
});

const run = (options: Parameters<typeof createBrandAlgorithm>[0]) => {
  const chain = createBrandAlgorithm(options) as ((seed: any, map?: any) => any)[];
  // Only the brand layer is exercised: lobe-ui's own algorithm is its concern.
  return chain.at(-1)!({}, { colorPrimary: 'lobe-primary', colorBgLayout: 'lobe-layout' });
};

describe('createBrandAlgorithm', () => {
  const theme = {
    neutralScale: scale('neutral'),
    primaryScale: scale('primary'),
  };

  it('keeps lobe-ui algorithm first and appends one brand layer', () => {
    const chain = createBrandAlgorithm({ appearance: 'light', theme }) as unknown[];

    expect(chain).toHaveLength(2);
  });

  it('replaces the primary, info and link families with the brand scale', () => {
    const token = run({ appearance: 'light', theme });

    expect(token.colorPrimary).toBe('primary-light-9');
    expect(token.colorPrimaryHover).toBe('primary-light-10');
    expect(token.colorInfo).toBe('primary-light-9');
    expect(token.colorLink).toBe('primary-light-9');
    expect(token.colorTextLightSolid).toBe('#ffffff');
  });

  it('lightens text roles in the dark appearance while solids stay on step 9', () => {
    const token = run({ appearance: 'dark', theme });

    expect(token.colorPrimary).toBe('primary-dark-9');
    expect(token.colorPrimaryText).toBe('primary-dark-10');
    expect(token.colorBorderSecondary).toBe('neutral-darkA-3');
  });

  it('leaves a family the user picked in Settings to lobe-ui', () => {
    const token = run({ appearance: 'light', skipNeutral: true, skipPrimary: true, theme });

    expect(token.colorPrimary).toBe('lobe-primary');
    expect(token.colorBgLayout).toBe('lobe-layout');
  });
});
