'use client';

import { Block } from '@lobehub/ui';
import { Descriptions } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

const styles = createStaticStyles(({ css, cssVar }) => ({
  label: css`
    min-width: 64px;
    color: ${cssVar.colorTextSecondary};
    white-space: nowrap;
  `,
  value: css`
    min-width: 0;
    color: ${cssVar.colorText};
    word-break: break-all;
  `,
}));

interface OrganizationIdentityProps {
  /** Account the login belongs to. */
  account: string;
  /** Normalized organization entry address; always shown so the user can check where they sign in. */
  entryUrl: string;
  /** From the id_token or the platform handoff; absent when the organization name is unknown. */
  organizationName?: string;
  /** From the id_token; absent when unknown. */
  organizationSlug?: string;
}

/** Organization / address / account summary shared by the confirmation card and the signed-in status. */
const OrganizationIdentity = memo<OrganizationIdentityProps>(
  ({ account, entryUrl, organizationName, organizationSlug }) => {
    const { t } = useTranslation('desktop-onboarding');

    // "Name（slug）", or whichever of the two is known.
    const organization =
      organizationName && organizationSlug
        ? t('screen5.identity.organizationWithSlug', {
            name: organizationName,
            slug: organizationSlug,
          })
        : organizationName || organizationSlug;

    const items = useMemo(
      () => [
        ...(organization
          ? [
              {
                children: organization,
                key: 'organization',
                label: t('screen5.identity.organization'),
              },
            ]
          : []),
        { children: entryUrl, key: 'address', label: t('screen5.identity.address') },
        { children: account, key: 'account', label: t('screen5.identity.account') },
      ],
      [account, entryUrl, organization, t],
    );

    return (
      <Block padding={16} variant={'filled'}>
        <Descriptions
          classNames={{ content: styles.value, label: styles.label }}
          colon={false}
          items={items}
        />
      </Block>
    );
  },
);

OrganizationIdentity.displayName = 'OrganizationIdentity';

export default OrganizationIdentity;
