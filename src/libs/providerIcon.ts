import { BRANDING_PROVIDER } from '@lobechat/business-const';
import {
  // eslint-disable-next-line no-restricted-imports -- loaded only through the lazy LobeIcons facade
  ProviderCombine as VendorProviderCombine,
  // eslint-disable-next-line no-restricted-imports -- loaded only through the lazy LobeIcons facade
  ProviderIcon as VendorProviderIcon,
  providerMappings,
  Unsloth,
} from '@lobehub/icons';
import { type ComponentProps, createElement } from 'react';

import { ProductLogo } from '@/components/Branding/ProductLogo';
import { isCustomBranding } from '@/const/version';

/**
 * @lobehub/icons 5.18 exports Unsloth but omits its provider mapping. Register
 * the official artwork until the library includes it, preserving an upstream
 * mapping when present. Keep this alongside provider icon consumers so the
 * complete mapping table stays outside the SPA's initial dependency graph.
 */
if (
  !providerMappings.some(({ keywords }) => keywords.some((key) => key.toLowerCase() === 'unsloth'))
) {
  providerMappings.push({ Icon: Unsloth, keywords: ['unsloth'] });
}

// Stored provider IDs remain unchanged in private deployments. Apply branding
// at the shared resolver, including error cards and combined wordmarks, rather
// than requiring every consumer to remember a separate branded component.
const isBrandedProvider = (provider?: string) =>
  isCustomBranding && provider?.toLowerCase() === BRANDING_PROVIDER.toLowerCase();

export const ProviderIcon = (props: ComponentProps<typeof VendorProviderIcon>) => {
  if (!isBrandedProvider(props.provider)) return createElement(VendorProviderIcon, props);

  const { className, forceMono, size = 24, style, type } = props;
  return createElement(ProductLogo, {
    className,
    size,
    style,
    type: type?.startsWith('combine') ? 'combine' : forceMono || type === 'mono' ? 'mono' : 'flat',
  });
};

export const ProviderCombine = (props: ComponentProps<typeof VendorProviderCombine>) => {
  if (!isBrandedProvider(props.provider)) return createElement(VendorProviderCombine, props);

  const { provider: _provider, size = 24, type: _type, ...rest } = props;
  return createElement(ProductLogo, { ...rest, size, type: 'combine' });
};
