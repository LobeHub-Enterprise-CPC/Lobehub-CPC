import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';
import { cssVar, ScrollShadow } from '@lobehub/ui';
import { type FC, type PropsWithChildren } from 'react';

const CategoryContainer: FC<PropsWithChildren<{ top?: number }>> = ({ children, top = 16 }) => {
  // The showcase market's categories sit on a tinted 184px panel that ends with
  // its last entry instead of filling the viewport.
  if (COMMUNITY_SHOWCASE_LAYOUT)
    return (
      <aside
        data-brand-slot={'community-categories'}
        style={{
          alignSelf: 'flex-start',
          background: cssVar.colorFillQuaternary,
          borderRadius: 16,
          flex: 'none',
          paddingBlock: 16,
          paddingInline: 12,
          position: 'sticky',
          top,
          width: 184,
        }}
      >
        {children}
      </aside>
    );

  return (
    <ScrollShadow
      hideScrollBar
      as={'aside'}
      flex={'none'}
      height={`calc(100vh - ${top * 2 + 4}px)`}
      offset={16}
      size={4}
      style={{ paddingBottom: 16, position: 'sticky', top }}
      width={280}
    >
      {children}
    </ScrollShadow>
  );
};

export default CategoryContainer;
