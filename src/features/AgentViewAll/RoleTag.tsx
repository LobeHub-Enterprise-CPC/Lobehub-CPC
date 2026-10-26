import { Tag } from '@lobehub/ui';
import * as stylex from '@stylexjs/stylex';
import { memo } from 'react';

const styles = stylex.create({
  // Shrinks well before the name beside it (a long role must never squeeze the
  // name away or run past the card), down to a stub that still reads as a tag.
  tag: {
    flexGrow: '0',
    flexShrink: '100',
    flexBasis: 'auto',
    minWidth: 32,
    maxWidth: '100%',
    overflow: 'hidden',
  },
  text: {
    display: 'block',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

/**
 * Style for the name a RoleTag sits beside: the name keeps its full width (any
 * shrink at all would ellipsize it) up to what the role's stub leaves, and the
 * role takes what remains.
 */
export const nameBesideRoleStyle = { flexShrink: 0, maxWidth: 'calc(100% - 40px)' } as const;

interface RoleTagProps {
  role: string;
}

/** An agent's role beside its name, truncated with the full text on hover. */
const RoleTag = memo<RoleTagProps>(({ role }) => (
  <Tag className={stylex.props(styles.tag).className} size={'small'} title={role}>
    <span {...stylex.props(styles.text)}>{role}</span>
  </Tag>
));

RoleTag.displayName = 'RoleTag';

export default RoleTag;
