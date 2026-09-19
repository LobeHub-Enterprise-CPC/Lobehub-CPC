import { ORG_NAME } from '@lobechat/business-const';
import { type LobeHubProps } from '@lobehub/ui/brand';
import { memo } from 'react';

import { isCustomORG } from '@/const/version';

import { ProductLogo } from '../ProductLogo';

export const OrgBrand = memo<LobeHubProps>((props) => {
  if (isCustomORG) {
    return <span>{ORG_NAME}</span>;
  }

  return <ProductLogo {...props} />;
});
