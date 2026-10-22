import { BRANDING_THEME } from '@lobechat/business-const';
import { buttonStyles, createGlobalStyle, cssVar, cx } from '@lobehub/ui';

/**
 * lobe-ui paints solid primary / danger labels with `colorBgLayout`, which only
 * works for its near-monochrome default primary. A saturated brand primary
 * needs the label pinned to `colorTextLightSolid`.
 *
 * Button puts `cx(base, size, variant, …)` on the node and antd-style merges
 * those keys into one class, so `.base.variantPrimary` never matches — the
 * selector has to be built from the same merged class.
 */
const solidButtonSelectors = () => {
  const sizes = [buttonStyles.sizeSmall, buttonStyles.sizeMiddle, buttonStyles.sizeLarge] as const;
  const solids = [buttonStyles.variantPrimary, buttonStyles.dangerSolid];
  const shapes = [undefined, buttonStyles.shapeRound, buttonStyles.shapeCircle];
  const classes = new Set<string>();

  const iconOnlyFor = (size: (typeof sizes)[number]) => {
    if (size === buttonStyles.sizeSmall) return buttonStyles.iconOnlySmall;
    if (size === buttonStyles.sizeLarge) return buttonStyles.iconOnlyLarge;
    return buttonStyles.iconOnlyMiddle;
  };

  const add = (...parts: (string | false | undefined)[]) => {
    const className = cx(...parts);
    if (!className) return;
    classes.add(
      className
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => `.${part}`)
        .join(''),
    );
  };

  for (const size of sizes) {
    for (const variant of solids) {
      for (const shape of shapes) {
        for (const block of [false, true]) {
          for (const iconEnd of [false, true]) {
            const parts = [
              buttonStyles.base,
              size,
              variant,
              shape,
              block && buttonStyles.block,
              iconEnd && buttonStyles.iconEnd,
            ];
            add(...parts);
            add(...parts, iconOnlyFor(size));
          }
        }
      }
    }
  }

  return [...classes].join(',\n  ');
};

const SolidButtonLabel = createGlobalStyle`
  ${solidButtonSelectors()} {
    &,
    &:hover,
    &:active {
      color: ${cssVar.colorTextLightSolid} !important;
    }
  }
`;

const BrandCss = createGlobalStyle`
  ${BRANDING_THEME?.globalStyle ?? ''}
`;

const BrandGlobalStyle = () => {
  if (!BRANDING_THEME) return null;

  return (
    <>
      {BRANDING_THEME.primaryScale && <SolidButtonLabel />}
      {BRANDING_THEME.globalStyle && <BrandCss />}
    </>
  );
};

export default BrandGlobalStyle;
