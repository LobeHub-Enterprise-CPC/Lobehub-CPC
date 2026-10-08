import { createStaticStyles, cssVar } from 'antd-style';

export const styles = createStaticStyles(({ css }) => ({
  nativeButton: css`
    border: 0;
    font-family: inherit;
    text-align: start;
    background: transparent;
  `,
  activeOption: css`
    background: ${cssVar.colorFillSecondary};
  `,
  agentTooltip: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 160px;
  `,
  agentTooltipCap: css`
    display: flex;
    gap: 6px;
    align-items: center;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  agentTooltipTitle: css`
    margin-block-end: 2px;
    font-size: 12px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  button: css`
    cursor: pointer;

    display: flex;
    flex: none;
    gap: 6px;
    align-items: center;

    padding-block: 2px;
    padding-inline: 4px;
    border-radius: 4px;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
    white-space: nowrap;

    transition: all 0.2s;

    &:hover {
      color: ${cssVar.colorText};
      background: ${cssVar.colorFillTertiary};
    }
  `,
  buttonDisabled: css`
    cursor: not-allowed;
    opacity: 0.5;

    &:hover {
      color: ${cssVar.colorTextSecondary};
      background: transparent;
    }
  `,
  option: css`
    cursor: pointer;

    width: 100%;
    padding-block: 10px;
    padding-inline: 8px;
    border-radius: ${cssVar.borderRadius};

    transition: background-color 0.2s;

    &:hover {
      background: ${cssVar.colorFillSecondary};
    }
  `,
  optionDisabled: css`
    cursor: not-allowed;
    opacity: 0.55;

    &:hover {
      background: transparent;
    }
  `,
  optionDesc: css`
    font-size: 12px;
    line-height: 1.4;
    color: ${cssVar.colorTextDescription};
  `,
  optionIcon: css`
    flex-shrink: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgElevated};
  `,
  optionTitle: css`
    font-size: 14px;
    font-weight: 500;
    line-height: 1.4;
    color: ${cssVar.colorText};
  `,
  popoverPopup: css`
    /* Option radius 8 + popup padding 4 = concentric outer radius 12. */
    &&& {
      border-radius: ${cssVar.borderRadiusLG};
    }
  `,
}));
