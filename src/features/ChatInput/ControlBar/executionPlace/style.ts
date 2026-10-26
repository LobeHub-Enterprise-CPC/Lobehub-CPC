import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';

/** 阴影/L from the design, tinted with the text colour so it follows the theme. */
const CARD_SHADOW = `0 2px 6px color-mix(in srgb, ${cssVar.colorText} 6%, transparent), 0 8px 28px -4px color-mix(in srgb, ${cssVar.colorText} 8%, transparent)`;

export const styles = stylex.create({
  check: {
    color: cssVar.colorText,
    flex: 'none',
  },
  chooseLink: {
    color: {
      'default': cssVar.colorTextTertiary,
      ':hover': cssVar.colorText,
    },
    textDecoration: 'none',
  },
  directoryList: {
    flexBasis: 'auto',
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 0,
    overflowY: 'auto',
  },
  directoryName: {
    color: cssVar.colorText,
    fontSize: 14,
    lineHeight: '22px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  directoryPath: {
    color: cssVar.colorTextTertiary,
    fontSize: 12,
    lineHeight: '20px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  directoryRow: {
    backgroundColor: {
      'default': 'transparent',
      ':hover': cssVar.colorFillTertiary,
    },
    borderRadius: cssVar.borderRadiusLG,
    cursor: 'pointer',
    paddingBlock: 10,
    paddingInline: 12,
  },
  directoryRowActive: {
    backgroundColor: {
      'default': cssVar.colorBgContainer,
      ':hover': cssVar.colorBgContainer,
    },
  },
  emptyHint: {
    color: cssVar.colorTextTertiary,
    fontSize: 12,
    lineHeight: '20px',
    paddingBlock: 4,
    paddingInline: 12,
  },
  headerAction: {
    backgroundColor: 'transparent',
    borderStyle: 'none',
    borderWidth: 0,
    color: {
      'default': cssVar.colorTextTertiary,
      ':hover': cssVar.colorText,
    },
    cursor: 'pointer',
    fontSize: 12,
    lineHeight: '20px',
    padding: 0,
  },
  headerLabel: {
    color: cssVar.colorTextTertiary,
    fontSize: 12,
    lineHeight: '20px',
  },
  item: {
    alignItems: 'center',
    backgroundColor: {
      'default': 'transparent',
      ':hover': cssVar.colorFillTertiary,
    },
    borderRadius: cssVar.borderRadius,
    borderStyle: 'none',
    borderWidth: 0,
    color: 'inherit',
    cursor: 'pointer',
    display: 'flex',
    gap: 12,
    paddingBlock: 8,
    paddingInline: 8,
    textAlign: 'start',
    width: '100%',
  },
  itemActive: {
    backgroundColor: {
      'default': cssVar.colorBgContainer,
      ':hover': cssVar.colorBgContainer,
    },
  },
  itemDesc: {
    color: cssVar.colorTextTertiary,
    fontSize: 12,
    lineHeight: '20px',
  },
  itemDisabled: {
    backgroundColor: {
      'default': 'transparent',
      ':hover': 'transparent',
    },
    cursor: 'not-allowed',
    opacity: 0.55,
  },
  itemIcon: {
    alignItems: 'center',
    color: cssVar.colorText,
    display: 'flex',
    flex: 'none',
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  itemMeta: {
    display: 'flex',
    flex: '1',
    flexDirection: 'column',
    minWidth: 0,
  },
  itemTitle: {
    color: cssVar.colorText,
    fontSize: 14,
    lineHeight: '22px',
  },
  menu: {
    backgroundColor: cssVar.colorBgElevated,
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: 16,
    borderStyle: 'solid',
    borderWidth: 1,
    boxShadow: CARD_SHADOW,
    boxSizing: 'border-box',
    padding: 8,
    width: 260,
  },
  popup: {
    position: 'relative',
  },
  // Stretches to the menu's height; deeper levels sit further out.
  side: {
    display: 'flex',
    gap: 8,
    insetBlock: 0,
    position: 'absolute',
  },
  sideLeft: {
    flexDirection: 'row-reverse',
    insetInlineEnd: 'calc(100% + 8px)',
  },
  sideRight: {
    flexDirection: 'row',
    insetInlineStart: 'calc(100% + 8px)',
  },
  // Every cascade level matches the menu: same width, the menu's height.
  panel: {
    backgroundColor: cssVar.colorBgElevated,
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: 16,
    borderStyle: 'solid',
    borderWidth: 1,
    boxShadow: CARD_SHADOW,
    boxSizing: 'border-box',
    flexShrink: 0,
    height: '100%',
    overflowY: 'auto',
    padding: 8,
    width: 260,
  },
  trigger: {
    alignItems: 'center',
    backgroundColor: {
      'default': 'transparent',
      ':hover': cssVar.colorFillTertiary,
    },
    borderRadius: cssVar.borderRadius,
    borderStyle: 'none',
    borderWidth: 0,
    color: {
      'default': cssVar.colorTextSecondary,
      ':hover': cssVar.colorText,
    },
    cursor: 'pointer',
    display: 'flex',
    flex: 'none',
    height: 28,
    justifyContent: 'center',
    outlineColor: {
      'default': 'transparent',
      ':focus-visible': cssVar.colorPrimary,
    },
    outlineOffset: {
      'default': 0,
      ':focus-visible': 1,
    },
    outlineStyle: {
      'default': 'none',
      ':focus-visible': 'solid',
    },
    outlineWidth: {
      'default': 0,
      ':focus-visible': 2,
    },
    padding: 4,
    width: 28,
  },
  triggerOpen: {
    backgroundColor: {
      'default': cssVar.colorFillSecondary,
      ':hover': cssVar.colorFillSecondary,
    },
    color: cssVar.colorText,
  },
  triggerReadonly: {
    backgroundColor: {
      'default': 'transparent',
      ':hover': 'transparent',
    },
    color: {
      'default': cssVar.colorTextSecondary,
      ':hover': cssVar.colorTextSecondary,
    },
    cursor: 'default',
  },
});
