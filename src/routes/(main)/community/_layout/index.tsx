import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { Flexbox } from '@lobehub/ui';
import { type FC } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';

import { featureFlagsSelectors, useServerConfigStore } from '@/store/serverConfig';

import Sidebar from './Sidebar';
import { styles } from './style';

// The showcase market is assistants, skills and connectors only: its landing
// page, models and providers are not part of it, so their URLs land on the
// assistant list instead of a page the tabs cannot reach.
const SHOWCASE_HIDDEN_PATH = /^\/community(?:\/(?:model|provider)(?:\/.*)?)?\/?$/;

const Layout: FC = () => {
  const { showMarket } = useServerConfigStore(featureFlagsSelectors);
  const { pathname } = useLocation();

  // `market: false` already hides Community from both the desktop and mobile
  // nav, but the routes stayed mounted — so a section a deployment deliberately
  // turned off was still one typed URL (or one stale link) away. Every community
  // route nests under this layout, so refusing here closes all of them at once.
  if (!showMarket) return <Navigate replace to={'/'} />;
  if (COMMUNITY_SHOWCASE_LAYOUT && SHOWCASE_HIDDEN_PATH.test(pathname))
    return <Navigate replace to={'/community/agent'} />;

  return (
    <>
      {!COMMUNITY_SHOWCASE_LAYOUT && <Sidebar />}
      <Flexbox className={styles.mainContainer} flex={1} height={'100%'}>
        <Outlet />
      </Flexbox>
    </>
  );
};

export default Layout;
