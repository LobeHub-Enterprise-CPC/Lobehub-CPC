import { Center, Checkbox, Flexbox, Spin } from '@lobehub/ui';
import { type CSSProperties, type ReactNode } from 'react';
import { memo, useState } from 'react';

import MiddleEllipsis from '@/components/MiddleEllipsis';

export interface CheckboxItemProps {
  checked?: boolean;
  disabled?: boolean;
  hasPadding?: boolean;
  id: string;
  label?: ReactNode;
  labelMaxWidth?: CSSProperties['maxWidth'];
  onUpdate: (id: string, enabled: boolean) => Promise<void>;
}

const CheckboxItem = memo<CheckboxItemProps>(
  ({ id, onUpdate, label, checked, disabled, hasPadding = true, labelMaxWidth }) => {
    const [loading, setLoading] = useState(false);
    const labelContent = label || id;

    const updateState = async () => {
      if (disabled) return;

      setLoading(true);
      await onUpdate(id, !checked);
      setLoading(false);
    };

    return (
      <Flexbox
        horizontal
        align={'center'}
        gap={24}
        justify={'space-between'}
        style={
          hasPadding
            ? {
                minWidth: 0,
                paddingLeft: 8,
              }
            : { minWidth: 0 }
        }
        onClick={async (e) => {
          e.stopPropagation();
          if (disabled) return;

          updateState();
        }}
      >
        <span
          title={typeof labelContent === 'string' ? labelContent : undefined}
          style={{
            display: 'flex',
            maxWidth: labelMaxWidth,
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          {typeof labelContent === 'string' ? <MiddleEllipsis text={labelContent} /> : labelContent}
        </span>
        {loading ? (
          <Center width={18}>
            <Spin size="small" />
          </Center>
        ) : (
          <Checkbox
            checked={checked}
            disabled={disabled}
            onClick={async (e) => {
              e.stopPropagation();
              if (disabled) return;

              await updateState();
            }}
          />
        )}
      </Flexbox>
    );
  },
);

export default CheckboxItem;
