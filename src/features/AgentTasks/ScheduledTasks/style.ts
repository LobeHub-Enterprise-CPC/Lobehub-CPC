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
    overflow-y: auto;
    flex: 1;

    min-width: 0;
    min-height: 0;
    padding-block: 32px;
    padding-inline: 48px;

    @media (width <= 1100px) {
      padding: 24px;
    }

    @media (width <= 767px) {
      padding-block: 20px;
      padding-inline: 16px;
    }
  `,
  properties: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
    gap: 24px;
    min-width: 0;

    @media (width <= 1000px) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    @media (width <= 480px) {
      grid-template-columns: minmax(0, 1fr);
    }
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
    gap: 20px;

    min-height: 0;
    padding: 4px;
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
      min-width: 0;
      max-width: 70%;
    }

    input {
      text-align: end;
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
