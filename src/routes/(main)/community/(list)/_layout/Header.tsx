'use client';

import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { cssVar } from '@lobehub/ui';
import { memo } from 'react';
import { useLocation } from 'react-router';

import NavHeader from '@/features/NavHeader';
import { MAX_WIDTH } from '@/routes/(main)/community/features/const';
import StoreSearchBar from '@/routes/(main)/community/features/Search';
import CommunityTabs from '@/routes/(main)/community/features/Showcase/CommunityTabs';
import UserAvatar from '@/routes/(main)/community/features/UserAvatar';
import { useGlobalStore } from '@/store/global';
import { systemStatusSelectors } from '@/store/global/selectors';

import SortButton from '../features/SortButton';
import { styles } from './Header/style';

const Header = memo(() => {
  const location = useLocation();
  const isHome = location.pathname === '/';
  const wideScreen = useGlobalStore(systemStatusSelectors.wideScreen);

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
        // Same column as the list below (`WideScreenContainer` with
        // `MAX_WIDTH`): on a wide window the tabs stay over the category panel
        // and the search over the cards instead of drifting to the edges.
        right={
          <div style={{ width: 320 }}>
            <StoreSearchBar />
          </div>
        }
        style={{
          alignSelf: 'center',
          height: 72,
          maxWidth: wideScreen ? undefined : MAX_WIDTH,
          paddingBlock: '32px 0',
          paddingInline: 48,
          width: '100%',
        }}
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
