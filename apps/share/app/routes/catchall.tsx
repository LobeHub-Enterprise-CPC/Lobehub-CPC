import { OFFICIAL_URL } from '@lobechat/business-const';
import type { LoaderFunctionArgs } from 'react-router';
import { redirect } from 'react-router';

import ShareLoading from '../../src/shell/ShareLoading';
import { cloudflareContext } from '../lib/cloudflareContext';

// `SHARE_APP_HOME` is the Cloudflare-worker deployment knob. When it is unset we
// must not fall back to upstream's marketing site: bouncing a white-label
// visitor to lobehub.com is the leak this route caused. Prefer the deployment's
// own home from the business-const slot, and keep the visitor in-site when even
// that is empty. `context.get` is optional-chained because this route also runs
// in the self-hosted build, where no worker context is ever provided.
export const loader = ({ context }: LoaderFunctionArgs) => {
  const appHome = context.get(cloudflareContext)?.env?.SHARE_APP_HOME as string | undefined;

  return redirect(appHome || OFFICIAL_URL || '/');
};

export default function ExitShare() {
  return <ShareLoading />;
}
