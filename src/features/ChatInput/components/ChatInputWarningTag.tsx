import { Icon, Tag } from '@lobehub/ui';
import { TriangleAlertIcon } from 'lucide-react';

/** Shared warning appearance for device and model conditions in the composer. */
export const ChatInputWarningTag = ({ label }: { label: string }) => (
  <Tag color={'warning'} icon={<Icon icon={TriangleAlertIcon} />} shape={'round'}>
    {label}
  </Tag>
);
