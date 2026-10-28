import { hasTenantPrefix } from '@lobechat/business-tenant/routing';
import { type AnchorHTMLAttributes } from 'react';
import React, { memo } from 'react';
import { Link as RouterLink } from 'react-router';

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  children?: React.ReactNode | undefined;
  href?: string;
}

/**
 * Smart Link component for global use.
 * - External links (http://, https://) → native <a> tag
 * - Paths that already name a tenant (/orgs/{slug}/…) → native <a> tag, so the
 *   router's tenant basename is not put in front of them again
 * - Internal routes → React Router Link
 */
const Link = memo<LinkProps>(({ href, children, ...props }) => {
  if (href?.startsWith('http://') || href?.startsWith('https://') || hasTenantPrefix(href ?? '')) {
    return (
      <a href={href} rel="noreferrer" {...props}>
        {children}
      </a>
    );
  }

  // Internal routes use React Router Link
  return (
    <RouterLink to={href || '/'} {...props}>
      {children}
    </RouterLink>
  );
});

export default Link;
