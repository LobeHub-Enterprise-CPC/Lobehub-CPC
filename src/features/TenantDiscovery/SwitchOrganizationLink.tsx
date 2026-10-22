import { Button, Text, createStaticStyles } from '@lobehub/ui';
('use client');

import { getTenant } from '@lobechat/business-tenant/client';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { getSwitchOrganizationUrl } from './switchOrganization';

const styles = createStaticStyles(({ css, cssVar }) => ({
  link: css`
    cursor: pointer;
    color: ${cssVar.colorPrimary};
    text-decoration: underline;
  `,
}));

interface SwitchOrganizationLinkProps {
  /**
   * `button` for places that already offer a button action (error alerts, overlays); `footer` is a
   * quiet centered line under a form; `inline` is the bare link for a line that lays itself out
   * (the current-organization bar).
   */
  appearance?: 'button' | 'footer' | 'inline';
  /**
   * This sign-in belongs to the desktop app's authorization. The organization is chosen in
   * the app, so instead of a link to the web lookup page the user is told where to go.
   */
  desktopAuth?: boolean;
  /** Fall back to the page origin when the server config has no `appUrl`. */
  originFallback?: boolean;
}

/** Leads back to the organization lookup page; renders nothing when that address is unknown. */
export const SwitchOrganizationLink = memo<SwitchOrganizationLinkProps>(
  ({ appearance = 'footer', desktopAuth, originFallback }) => {
    const { t } = useTranslation('auth');
    if (desktopAuth)
      return getTenant() ? (
        <Text
          align={appearance === 'button' ? undefined : 'center'}
          fontSize={13}
          style={appearance === 'footer' ? { marginTop: 16 } : undefined}
          type={'secondary'}
        >
          {t('organization.desktop.switchHint')}
        </Text>
      ) : null;

    const href = getSwitchOrganizationUrl({ originFallback });
    if (!href) return null;

    if (appearance === 'button')
      return <Button href={href}>{t('organization.switch.link')}</Button>;

    const link = (
      <a className={styles.link} href={href}>
        {t('organization.switch.link')}
      </a>
    );
    return appearance === 'inline' ? (
      <Text align={'center'} fontSize={13} type={'secondary'}>
        {link}
      </Text>
    ) : (
      <Text align={'center'} fontSize={13} style={{ marginTop: 16 }} type={'secondary'}>
        {link}
      </Text>
    );
  },
);

SwitchOrganizationLink.displayName = 'SwitchOrganizationLink';
