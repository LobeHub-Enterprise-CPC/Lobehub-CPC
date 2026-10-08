import { Flexbox } from '@lobehub/ui';
import { Text } from '@lobehub/ui/base-ui';
import { Hash } from 'lucide-react';

import NavHeader from '@/features/NavHeader';

import { MemberStatus } from './MemberStatus';
import type { ChannelDetail, ChannelReceipts } from './receipts';

export function ChannelHeader({
  data,
  receipts,
  onRefresh,
}: {
  data: ChannelDetail;
  receipts: ChannelReceipts;
  onRefresh: () => Promise<unknown>;
}) {
  return (
    <NavHeader
      right={<MemberStatus data={data} receipts={receipts} onRefresh={onRefresh} />}
      left={
        <Flexbox horizontal align="center" gap={8}>
          <Hash size={18} />
          <Text ellipsis weight={500}>
            {data.channel.title}
          </Text>
        </Flexbox>
      }
    />
  );
}
