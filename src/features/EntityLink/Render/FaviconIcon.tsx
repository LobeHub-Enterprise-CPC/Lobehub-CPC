import { Globe } from 'lucide-react';
import { memo, useState } from 'react';

import { isCustomBranding } from '@/const/version';

import { stripWww } from '../parse';

interface FaviconIconProps {
  domain: string;
  size?: number;
}

/** The deployment's own favicon, served from `public/` — never a third party. */
const LOCAL_FAVICON = '/favicon.ico';

const isSameOrigin = (domain: string) => {
  if (typeof window === 'undefined') return false;
  return stripWww(window.location.hostname) === stripWww(domain);
};

/**
 * Inline site favicon for generic external links. Falls back to a globe glyph
 * when the favicon cannot be loaded.
 *
 * Links back to this deployment use its own favicon. Everything else needs a
 * third-party lookup (DuckDuckGo), which tells that service which link domains
 * a user is reading — so white-label deployments, which are private/on-prem,
 * skip it and show the globe glyph instead.
 */
const FaviconIcon = memo<FaviconIconProps>(({ domain, size = 15 }) => {
  const [failed, setFailed] = useState(false);
  const sameOrigin = isSameOrigin(domain);

  if (failed || (!sameOrigin && isCustomBranding)) return <Globe size={size} />;

  return (
    <img
      alt=""
      height={size}
      src={sameOrigin ? LOCAL_FAVICON : `https://icons.duckduckgo.com/ip3/${domain}.ico`}
      style={{ borderRadius: 3, objectFit: 'contain' }}
      width={size}
      onError={() => setFailed(true)}
    />
  );
});

FaviconIcon.displayName = 'FaviconIcon';

export default FaviconIcon;
