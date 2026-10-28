'use client';

import { ActionIcon, Flexbox } from '@lobehub/ui';
import { PencilLineIcon, SearchIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { ProductLogo } from '@/components/Branding';
import { DESKTOP_HEADER_ICON_SMALL_SIZE } from '@/const/layoutTokens';
import { startNewHomeChat } from '@/features/Home/startNewHomeChat';
import NavItem from '@/features/NavPanel/components/NavItem';
import SideBarHeaderLayout from '@/features/NavPanel/SideBarHeaderLayout';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import WorkspaceLink from '@/features/Workspace/WorkspaceLink';
import { useGlobalStore } from '@/store/global';
import { isModifierClick } from '@/utils/navigation';

import InboxButton from './InboxButton';

/**
 * Home panel header for the two-level navigation (`NAV_RAIL_ENABLED`): the rail
 * owns page links and the account entry, so the panel leads with the product
 * mark, the inbox and search, then the new-chat entry.
 */
const BrandHeader = memo(() => {
  const { t } = useTranslation('common');
  const { t: tElectron } = useTranslation('electron');
  const navigate = useWorkspaceAwareNavigate();
  const toggleCommandMenu = useGlobalStore((s) => s.toggleCommandMenu);

  return (
    <div data-brand-slot="home-sidebar-header">
      <SideBarHeaderLayout
        showBack={false}
        left={
          <Flexbox paddingInline={6}>
            <ProductLogo size={20} type={'combine'} />
          </Flexbox>
        }
        right={
          <>
            <InboxButton />
            <ActionIcon
              icon={SearchIcon}
              size={DESKTOP_HEADER_ICON_SMALL_SIZE}
              title={t('tab.search')}
              onClick={() => toggleCommandMenu(true)}
            />
          </>
        }
      />
      <Flexbox paddingInline={4}>
        <WorkspaceLink
          to={'/'}
          onClick={(e) => {
            if (isModifierClick(e)) return;
            e.preventDefault();
            // A plain new chat is not filed under the project a "+" picked.
            startNewHomeChat(navigate);
          }}
        >
          <NavItem icon={PencilLineIcon} title={tElectron('navigation.newChat')} />
        </WorkspaceLink>
      </Flexbox>
    </div>
  );
});

BrandHeader.displayName = 'BrandHeader';

export default BrandHeader;
