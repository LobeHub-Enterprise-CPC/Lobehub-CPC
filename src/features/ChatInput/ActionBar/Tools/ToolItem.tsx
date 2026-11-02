import { Flexbox, Text } from '@lobehub/ui';
import { memo, Suspense } from 'react';

import DebugNode from '@/components/DebugNode';
import RevokedTag from '@/features/MarketAssetAccess/RevokedTag';
import { useRevokedMarketAssets } from '@/hooks/useRevokedMarketAssets';

import type { CheckboxItemProps } from '../components/CheckboxWithLoading';
import CheckboxItem from '../components/CheckboxWithLoading';

const ToolItem = memo<CheckboxItemProps>(({ id, onUpdate, label, checked, disabled }) => {
  // An installed Market tool the enterprise stopped making available never runs; show why.
  const revoked = useRevokedMarketAssets().has(id);
  return (
    <Suspense fallback={<DebugNode trace="ActionBar/Tools/ToolItem" />}>
      <CheckboxItem
        checked={revoked ? false : checked}
        disabled={revoked || disabled}
        hasPadding={false}
        id={id}
        label={
          <Flexbox allowShrink horizontal align={'center'} gap={8}>
            <Text
              style={{ lineHeight: 1.4, paddingBlock: 1 }}
              ellipsis={{
                tooltipWhenOverflow: true,
              }}
            >
              {label || id}
            </Text>
            {revoked && <RevokedTag />}
          </Flexbox>
        }
        onUpdate={onUpdate}
      />
    </Suspense>
  );
});

export default ToolItem;
