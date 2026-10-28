import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { Flexbox } from '@lobehub/ui';
import { Outlet } from 'react-router';

import CategoryContainer from '../../../components/CategoryContainer';
import Category from '../features/Category';
import { styles } from './style';

const Layout = () => {
  return (
    <Flexbox
      horizontal
      className={styles.mainContainer}
      gap={COMMUNITY_SHOWCASE_LAYOUT ? 32 : 24}
      width={'100%'}
    >
      <CategoryContainer>
        <Category />
      </CategoryContainer>
      <Flexbox flex={1} gap={16}>
        <Outlet />
      </Flexbox>
    </Flexbox>
  );
};

export default Layout;
