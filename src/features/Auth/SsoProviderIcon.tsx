import { createStaticStyles } from '@lobehub/ui';
import { memo, type ReactNode, useState } from 'react';

const styles = createStaticStyles(({ css, cssVar }) => ({
  logo: css`
    flex: none;
    border-radius: ${cssVar.borderRadiusSM};
    object-fit: contain;
  `,
}));

interface SsoProviderIconProps {
  /** Shown while a provider has no custom logo, and when the logo cannot be loaded. */
  fallback: ReactNode;
  /** The image an administrator configured for the provider (public HTTPS URL). */
  logoUrl?: string | null;
  size?: number;
}

/**
 * A provider's custom logo, or `fallback` (its built-in icon) when it has none
 * or the image fails to load. Failure is remembered per URL, so a changed logo
 * is tried again.
 */
export const SsoProviderIcon = memo<SsoProviderIconProps>(({ fallback, logoUrl, size = 18 }) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (!logoUrl || failedUrl === logoUrl) return <>{fallback}</>;

  return (
    <img
      alt=""
      className={styles.logo}
      height={size}
      referrerPolicy="no-referrer"
      src={logoUrl}
      width={size}
      onError={() => setFailedUrl(logoUrl)}
    />
  );
});

SsoProviderIcon.displayName = 'SsoProviderIcon';

export default SsoProviderIcon;
