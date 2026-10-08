import { Icon } from '@lobehub/ui';
import { cssVar } from 'antd-style';
import { CornerDownRight } from 'lucide-react';

import NavItem, { type NavItemProps } from './NavItem';

interface ThreadNavItemProps extends NavItemProps {
  nested?: boolean;
}

/** Shared thread row; nesting keeps the highlight full-width while indenting its content. */
export default function ThreadNavItem({ nested, style, ...props }: ThreadNavItemProps) {
  return (
    <NavItem
      icon={<Icon color={cssVar.colorTextDescription} icon={CornerDownRight} size="small" />}
      style={{ minHeight: 36, ...(nested && { paddingInlineStart: 32 }), ...style }}
      {...props}
    />
  );
}
