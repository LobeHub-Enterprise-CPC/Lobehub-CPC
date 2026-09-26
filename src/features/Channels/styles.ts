import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  layout: css`
    height: 100%;
    min-height: 0;
    color: ${cssVar.colorText};
    background: ${cssVar.colorBgContainer};
  `,
  body: css`
    flex: 1;
    min-width: 0;
    min-height: 0;
  `,
  conversations: css`
    position: relative;

    overflow: hidden;
    flex: 1;

    min-width: 0;
    min-height: 0;
  `,
  threadPanel: css`
    z-index: 10;
    flex-shrink: 0;
    height: 100%;
    background: ${cssVar.colorBgContainer};
  `,
  threadContent: css`
    overflow: hidden;
    display: flex;
    flex-direction: column;

    height: 100%;
    min-height: 0;
  `,
  threadHeader: css`
    flex-shrink: 0;
    padding-block: 8px;
    padding-inline: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  threadRoot: css`
    flex-shrink: 0;
  `,
  replyDivider: css`
    padding-block: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  replyLink: css`
    align-self: flex-start;
    margin-block: 0 16px;
  `,
  feed: css`
    overflow: auto;
    flex: 1;
    min-height: 0;
    padding-block: 8px 24px;
  `,
  message: css`
    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 12px;
    background: ${cssVar.colorBgContainer};
  `,
  approvals: css`
    overflow: auto;
    max-height: 45%;
  `,
  approvalPayload: css`
    overflow: auto;

    max-height: 180px;
    margin: 0;

    overflow-wrap: anywhere;
    white-space: pre-wrap;
  `,
  activity: css`
    overflow: auto;
    display: flex;
    flex-flow: row wrap;
    flex-shrink: 0;
    gap: 0 12px;
    align-content: center;
    align-items: center;

    height: 56px;

    font-size: 12px;
    line-height: 18px;
    color: ${cssVar.colorTextSecondary};
    white-space: normal;
  `,
  composer: css`
    flex-shrink: 0;
    padding-block: 0 8px;
  `,
  muted: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  form: css`
    overflow: auto;
    align-self: center;
    width: min(100%, 680px);
    padding: 32px;
  `,
  agentList: css`
    overflow: auto;
    max-height: 360px;
  `,
  agentOption: css`
    cursor: pointer;

    display: flex;
    gap: 12px;
    align-items: center;

    padding: 12px;
    border-radius: ${cssVar.borderRadius};

    &:hover,
    &:has(input:checked) {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  error: css`
    color: ${cssVar.colorError};
  `,
}));
