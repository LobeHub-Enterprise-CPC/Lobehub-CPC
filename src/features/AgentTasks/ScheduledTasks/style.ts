// eslint-disable-next-line stylex-migration/no-emotion-styles -- Enterprise lobe-design mandates createStaticStyles for this UI.
import { createStaticStyles } from '@lobehub/ui';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  root: css`
    overflow: hidden;
    display: flex;
    flex: 1;

    min-width: 0;
    min-height: 0;

    background: ${cssVar.colorBgContainer};
  `,
  sidebar: css`
    display: flex;
    flex: 0 0 248px;
    flex-direction: column;

    min-height: 0;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 767px) {
      flex-basis: 100%;
    }
  `,
  list: css`
    overflow-y: auto;
    min-height: 0;
    padding: 12px;
  `,
  detail: css`
    container-type: inline-size;
    overflow-y: auto;
    flex: 1;

    min-width: 0;
    min-height: 0;
    padding-block: 40px;
    padding-inline: 48px;

    @media (width <= 1100px) {
      padding: 24px;
    }

    @media (width <= 767px) {
      --scheduled-back-display: inline-flex;
      padding-block: 20px;
      padding-inline: 16px;
    }
  `,
  properties: css`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 28px 32px;
    min-width: 0;
    > * {
      min-width: 0;
    }
    @container (width < 760px) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    @container (width < 400px) {
      grid-template-columns: minmax(0, 1fr);
    }
  `,
  sidebarHeader: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 96px;
    padding: 16px 20px 40px;
  `,
  taskItem: css`
    width: 100%;
    justify-content: flex-start;
    min-height: 56px;
    padding: 6px 8px;
    text-align: start;
    border: 0;
    box-shadow: none;
    color: inherit;
    background: transparent;
    > .lobe-flex {
      flex: 1;
      text-align: start;
    }
  `,
  selectedTask: css`
    &,
    &:focus-visible {
      color: ${cssVar.colorText};
    }
    background: ${cssVar.colorPrimaryBg};
    &:hover {
      background: ${cssVar.colorPrimaryBgHover};
    }
  `,
  mutedTask: css`
    color: ${cssVar.colorTextTertiary};
  `,
  pill: css`
    border-radius: 999px;
    padding-inline: 18px;
    height: 40px;
  `,
  summaryValue: css`
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    overflow-wrap: anywhere;
  `,
  advancedToggle: css`
    justify-content: flex-start;
    padding: 0;
    min-height: 24px;
    color: ${cssVar.colorTextSecondary};
    font-size: 12px;
  `,
  description: css`
    line-height: 1.7;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  `,
  clamped: css`
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
  `,
  run: css`
    width: 100%;
    min-height: 56px;
    padding: 16px;
    border: 0;
    box-shadow: none;
    border-radius: ${cssVar.borderRadiusLG};

    text-align: start;
    white-space: normal;

    background: ${cssVar.colorFillQuaternary};
  `,
  chat: css`
    display: flex;
    flex: 0 0 min(480px, 40%);
    flex-direction: column;

    min-width: 0;
    min-height: 0;
    border-inline-start: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 767px) {
      flex-basis: 100%;
    }
  `,
  form: css`
    display: flex;
    flex-direction: column;
    gap: 20px;
    min-height: 0;
  `,
  formBody: css`
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 24px;

    min-height: 0;
    padding: 0;
  `,
  row: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    min-height: 48px;
    padding-block: 8px;
    padding-inline: 12px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: ${cssVar.borderRadiusLG};

    > label {
      flex-shrink: 0;
      font-size: 14px;
    }

    > :last-child {
      margin-inline-start: auto;
      min-width: 0;
      max-width: 70%;
    }

    input {
      text-align: end;
    }
    [role='combobox'] {
      justify-content: flex-end;
      text-align: end;
    }
    .lobe-select__value {
      justify-content: flex-end;
    }
    .lobe-select__suffix:empty {
      display: none;
    }
  `,
  nativeInput: css`
    min-width: 0;
    padding: 4px;
    border: none;
    border-radius: ${cssVar.borderRadiusSM};

    font: inherit;
    color: ${cssVar.colorText};

    color-scheme: light dark;
    background: transparent;
  `,
  footer: css`
    display: flex;
    flex-shrink: 0;
    gap: 8px;
    justify-content: flex-end;
  `,
}));
