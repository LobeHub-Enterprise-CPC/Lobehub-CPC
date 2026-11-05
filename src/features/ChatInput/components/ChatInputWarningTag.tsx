import { Icon, Tag } from '@lobehub/ui';
import * as stylex from '@stylexjs/stylex';
import { TriangleAlertIcon } from 'lucide-react';

const styles = stylex.create({
  // The triangle's wide base puts its visible center below the text.
  icon: { transform: 'translateY(-1px)' },
  label: { lineHeight: 1 },
});

/** Shared warning appearance for device and model conditions in the composer. */
export const ChatInputWarningTag = ({ label }: { label: string }) => (
  <Tag
    color={'warning'}
    shape={'round'}
    icon={
      <Icon className={stylex.props(styles.icon).className} icon={TriangleAlertIcon} size={12} />
    }
  >
    <span {...stylex.props(styles.label)}>{label}</span>
  </Tag>
);
