import { getTenant } from '@lobechat/business-tenant/client';
import { Flexbox } from '@lobehub/ui';
import { Text } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { SwitchOrganizationLink } from '@/features/TenantDiscovery/SwitchOrganizationLink';

/** The locale key and values of the line: the name is shown only when it adds to the slug. */
export const organizationLabelOf = ({ name, slug }: { name?: string; slug: string }) =>
  name && name !== slug
    ? ({ key: 'organization.current.named', values: { name, slug } } as const)
    : ({ key: 'organization.current.slugOnly', values: { slug } } as const);

interface CurrentOrganizationProps {
  /** The sign-in serves the desktop app's authorization: the switch is a hint, not a web link. */
  desktopAuth?: boolean;
  /** The surrounding card already offers the way out (the unavailable organization alert). */
  hideSwitch?: boolean;
}

/**
 * Which organization this sign-in page belongs to, with the way to another one. Only an
 * organization document has one: the line is absent on the unscoped pages.
 *
 * The directory name is bootstrapped by the server; without it (or when it only repeats the
 * slug) the line carries the slug alone, so the user still sees where they are signing in.
 */
export const CurrentOrganization = memo<CurrentOrganizationProps>(({ desktopAuth, hideSwitch }) => {
  const { t } = useTranslation('auth');
  const tenant = getTenant();
  if (!tenant) return null;

  const { key, values } = organizationLabelOf(tenant);

  return (
    <Flexbox align={'center'} gap={4} style={{ marginTop: 16 }}>
      <Text align={'center'} fontSize={13} type={'secondary'} wordBreak={'break-word'}>
        {t(key, values)}
      </Text>
      {!hideSwitch && <SwitchOrganizationLink appearance={'inline'} desktopAuth={desktopAuth} />}
    </Flexbox>
  );
});

CurrentOrganization.displayName = 'CurrentOrganization';
