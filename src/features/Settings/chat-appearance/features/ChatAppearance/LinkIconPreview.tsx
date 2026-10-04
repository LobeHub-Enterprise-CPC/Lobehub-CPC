'use client';

import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { Trans } from 'react-i18next';

import { EntityLinkRender, type LobeLinkKind } from '@/features/EntityLink';

const styles = createStaticStyles(({ css, cssVar }) => ({
  bubble: css`
    align-self: flex-start;

    padding-block: 10px;
    padding-inline: 14px;
    border-radius: 12px;

    font-size: 14px;
    line-height: 1.8;
    color: ${cssVar.colorText};

    background: ${cssVar.colorFillTertiary};
  `,
}));

interface SampleLinkProps {
  domain?: string;
  href: string;
  kind: LobeLinkKind;
  label: string;
}

// Reuse the real message link renderer so the preview reflects the live
// `enableMessageLinkIcon` setting exactly as chat messages do.
const SampleLink = memo<SampleLinkProps>(({ kind, href, label, domain }) => (
  <EntityLinkRender
    id={`link-icon-preview-${kind}`}
    node={{ properties: { linkDomain: domain, linkHref: href, linkKind: kind, linkLabel: label } }}
    tagName="lobeLink"
    type="element"
  >
    {null}
  </EntityLinkRender>
));

const LinkIconPreview = memo(() => (
  <div className={styles.bubble}>
    <Trans
      i18nKey="settingChatAppearance.linkIcon.previewMessage"
      ns="setting"
      components={{
        repo: (
          <SampleLink
            href="https://github.com/octocat/hello-world"
            kind="github"
            label="octocat/hello-world"
          />
        ),
        site: (
          <SampleLink
            domain="example.com"
            href="https://example.com"
            kind="generic"
            label="example.com"
          />
        ),
      }}
    />
  </div>
));

LinkIconPreview.displayName = 'LinkIconPreview';

export default LinkIconPreview;
