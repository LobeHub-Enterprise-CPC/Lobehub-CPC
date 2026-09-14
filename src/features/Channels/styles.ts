import { createStaticStyles } from 'antd-style';

export const styles = createStaticStyles(({ css, cssVar }) => ({
  layout: css`
    height: 100%;
    min-height: 0;
    color: ${cssVar.colorText};
    background: ${cssVar.colorBgContainer};
  `,
  body: css`
    overflow: hidden;
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
  threadRoot: css`
    flex-shrink: 0;
  `,
  feed: css`
    overflow: auto;
    flex: 1;
    min-height: 0;
    padding-block: 8px 24px;
  `,
  channelMessage: css`
    > .message-header {
      width: 100%;
      min-height: 24px;
      padding-inline-end: 32px;
    }
  `,
  messageAvatar: css`
    position: absolute;
    inset-block-start: 12px;
    inset-inline-start: 0;
  `,
  branchAction: css`
    position: absolute;
    inset-block-start: 12px;
    inset-inline-end: 0;
    flex-shrink: 0;

    @media (hover: hover) {
      pointer-events: none;
      opacity: 0;

      .message-wrapper:hover &,
      .message-wrapper:focus-within & {
        pointer-events: auto;
        opacity: 1;
      }
    }
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

    min-height: 32px;
    max-height: 96px;
    padding-block: 8px;

    font-size: ${cssVar.fontSizeSM};
    line-height: ${cssVar.lineHeightSM};
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
  error: css`
    color: ${cssVar.colorError};
  `,
}));
