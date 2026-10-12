'use client';

import { NAV_RAIL_ENABLED } from '@lobechat/business-const';

import SideBarHeaderLayout from '@/features/NavPanel/SideBarHeaderLayout';

import BrandHeader from './components/BrandHeader';
import InboxButton from './components/InboxButton';
import Nav from './components/Nav';
import User from './components/User';

const Header = () => {
  if (NAV_RAIL_ENABLED) return <BrandHeader />;

  return (
    <>
      <SideBarHeaderLayout left={<User />} right={<InboxButton />} showBack={false} />
      <Nav />
    </>
  );
};

export default Header;
