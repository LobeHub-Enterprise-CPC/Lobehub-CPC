'use client';

import { toast } from '@lobehub/ui';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { CopyIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { brandIcon } from '@/components/BrandIcon';
import { ProductLogo } from '@/components/Branding';

const CopyGlyph = brandIcon('community.copy', CopyIcon);

const styles = stylex.create({
  art: {
    alignItems: 'center',
    backgroundColor: cssVar.colorFillQuaternary,
    backgroundImage: `radial-gradient(${cssVar.colorBorderSecondary} 1px, transparent 1px)`,
    backgroundSize: '12px 12px',
    borderRadius: 8,
    display: 'flex',
    height: 96,
    justifyContent: 'center',
  },
  button: {
    alignItems: 'center',
    backgroundColor: {
      'default': `color-mix(in srgb, ${cssVar.colorPrimary} 6%, ${cssVar.colorBgContainer})`,
      ':hover': `color-mix(in srgb, ${cssVar.colorPrimary} 12%, ${cssVar.colorBgContainer})`,
    },
    borderColor: cssVar.colorPrimaryBorder,
    borderRadius: 8,
    borderStyle: 'solid',
    borderWidth: 1,
    color: cssVar.colorPrimary,
    cursor: 'pointer',
    display: 'flex',
    fontSize: 14,
    fontWeight: 500,
    gap: 8,
    height: 44,
    justifyContent: 'center',
    width: '100%',
  },
  card: {
    borderColor: cssVar.colorBorderSecondary,
    borderRadius: 12,
    borderStyle: 'solid',
    borderWidth: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 16,
    textAlign: 'center',
  },
  desc: {
    color: cssVar.colorTextSecondary,
    fontSize: 12,
    lineHeight: '20px',
    margin: 0,
    marginBlockEnd: 8,
  },
  logoTile: {
    alignItems: 'center',
    backgroundColor: cssVar.colorBgContainer,
    borderRadius: 12,
    boxShadow: cssVar.boxShadowTertiary,
    display: 'flex',
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  title: {
    color: cssVar.colorText,
    fontSize: 14,
    fontWeight: 500,
    lineHeight: '22px',
    marginBlockStart: 8,
  },
});

/**
 * "Send the prompt to your AI": copies a ready-made prompt that tells any
 * assistant what this item is and how to set it up.
 */
const CopyPromptCard = memo<{ kind: 'agent' | 'mcp' | 'skill'; prompt: string }>(
  ({ kind, prompt }) => {
    const { t } = useTranslation('discover');

    return (
      <div data-brand-slot={'community-copy-prompt'} {...stylex.props(styles.card)}>
        <div aria-hidden {...stylex.props(styles.art)}>
          <div {...stylex.props(styles.logoTile)}>
            <ProductLogo size={32} type={'mono'} />
          </div>
        </div>
        <span {...stylex.props(styles.title)}>{t('showcase.copyPrompt.title')}</span>
        <p {...stylex.props(styles.desc)}>{t(`showcase.copyPrompt.desc.${kind}`)}</p>
        <button
          type={'button'}
          onClick={async () => {
            await navigator.clipboard.writeText(prompt);
            toast.success(t('showcase.copyPrompt.copied'));
          }}
          {...stylex.props(styles.button)}
        >
          <CopyGlyph size={16} />
          {t('showcase.copyPrompt.button')}
        </button>
      </div>
    );
  },
);

CopyPromptCard.displayName = 'CopyPromptCard';

export default CopyPromptCard;
