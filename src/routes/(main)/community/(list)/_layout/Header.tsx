'use client';

import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { cssVar } from '@lobehub/ui';
import { memo } from 'react';
import { useLocation } from 'react-router';

import NavHeader from '@/features/NavHeader';
import StoreSearchBar from '@/routes/(main)/community/features/Search';
import CommunityTabs from '@/routes/(main)/community/features/Showcase/CommunityTabs';
import UserAvatar from '@/routes/(main)/community/features/UserAvatar';

import SortButton from '../features/SortButton';
import { styles } from './Header/style';

const Header = memo(() => {
  const location = useLocation();
  const isHome = location.pathname === '/';

  const cssVariables: Record<string, string> = {
    '--header-border-color': cssVar.colorBorderSecondary,
  };

  // The showcase market leads with its three kinds and keeps search to the
  // right; sorting moves beside each list's title.
  if (COMMUNITY_SHOWCASE_LAYOUT)
    return (
      <NavHeader
        data-brand-slot={'community-header'}
        left={<CommunityTabs />}
        style={{ height: 72, paddingBlock: '32px 0', paddingInline: 48 }}
        right={
          <div style={{ width: 320 }}>
            <StoreSearchBar />
          </div>
        }
      />
    );

  return (
    <NavHeader
      className={styles.headerContainer}
      left={<StoreSearchBar />}
      style={cssVariables}
      right={
        !isHome && (
          <>
            <SortButton />
            <UserAvatar />
          </>
        )
      }
      styles={{
        left: { flex: 1 },
      }}
    />
  );
});

export default Header;
