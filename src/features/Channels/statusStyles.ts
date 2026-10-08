import { createStaticStyles } from 'antd-style';

export const statusStyles = createStaticStyles(({ css, cssVar }) => ({
  receipts: css`
    align-self: flex-start;
    max-width: 100%;
    font-size: ${cssVar.fontSizeSM};
  `,
  chip: css`
    max-width: 100%;
    height: auto;
    min-height: 28px;
    padding-block: 4px;
    padding-inline: 8px;

    font-size: ${cssVar.fontSizeSM};
    white-space: normal;

    background: ${cssVar.colorFillQuaternary};
  `,
  name: css`
    overflow: hidden;
    max-width: 112px;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  state: css`
    display: inline-flex;
    gap: 4px;
    align-items: center;
    color: ${cssVar.colorTextSecondary};

    &[data-tone='working'] {
      color: ${cssVar.colorInfo};
    }

    &[data-tone='attention'] {
      color: ${cssVar.colorWarning};
    }

    &[data-tone='error'] {
      color: ${cssVar.colorError};
    }
  `,
  dot: css`
    flex: none;

    width: 6px;
    height: 6px;
    border-radius: 50%;

    background: currentcolor;
  `,
  popover: css`
    width: 288px;
    max-width: calc(100vw - 48px);

    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorText};
    overflow-wrap: anywhere;
  `,
  muted: css`
    color: ${cssVar.colorTextSecondary};
  `,
  environment: css`
    padding-block-start: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};
    color: ${cssVar.colorTextSecondary};
    overflow-wrap: anywhere;
  `,
  memberButton: css`
    position: relative;

    flex: none;

    width: 32px;
    min-width: 32px;
    height: 32px;
    padding: 4px;

    &[data-popup-open] {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  memberDot: css`
    position: absolute;
    inset-block-end: 3px;
    inset-inline-end: 3px;

    border: 2px solid ${cssVar.colorBgContainer};
    border-radius: 50%;
  `,
  members: css`
    gap: 4px;
    min-width: 0;

    @media (width <= 640px) {
      gap: 0;
    }
  `,
}));
