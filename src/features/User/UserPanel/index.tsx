'use client';

import { NAV_RAIL_ENABLED } from '@lobechat/business-const';
import { createStaticStyles, cx, Popover } from '@lobehub/ui';
import { type PropsWithChildren } from 'react';
import { memo, Suspense, useState } from 'react';

import { isDesktop } from '@/const/version';

import PanelContent from './PanelContent';
import PanelContentSkeleton from './PanelContentSkeleton';
import UpgradeBadge from './UpgradeBadge';
import { useNewVersion } from './useNewVersion';

const styles = createStaticStyles(({ css }) => {
  return {
    // Without the rail the avatar sits in the top-left corner, so the panel is
    // pinned there. On the rail it sits at the bottom and the panel anchors to it.
    pinned: css`
      inset-block-start: ${isDesktop ? 32 : 8}px !important;
      inset-inline-start: 8px !important;
    `,
    popover: css`
      border-radius: 10px;
    `,
    popoverContent: css`
      padding: 0;
    `,
  };
});

const UserPanel = memo<PropsWithChildren>(({ children }) => {
  const hasNewVersion = useNewVersion();
  const [open, setOpen] = useState(false);

  return (
    <Suspense fallback={children}>
      <UpgradeBadge showBadge={hasNewVersion}>
        <Popover
          arrow={false}
          open={open}
          placement={NAV_RAIL_ENABLED ? 'rightBottom' : 'topLeft'}
          trigger="click"
          classNames={{
            root: NAV_RAIL_ENABLED ? styles.popover : cx(styles.popover, styles.pinned),
            content: styles.popoverContent,
          }}
          content={
            <div data-brand-slot={'user-panel'}>
              <Suspense fallback={<PanelContentSkeleton />}>
                <PanelContent closePopover={() => setOpen(false)} />
              </Suspense>
            </div>
          }
          onOpenChange={setOpen}
        >
          {children}
        </Popover>
      </UpgradeBadge>
    </Suspense>
  );
});

UserPanel.displayName = 'UserPanel';

export default UserPanel;
