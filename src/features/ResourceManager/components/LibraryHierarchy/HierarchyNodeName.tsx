import { memo } from 'react';

import MiddleEllipsis from '@/components/MiddleEllipsis';

/** Enough for a serial and an extension, which is where sibling names differ. */
const TAIL_LENGTH = 10;

const LABEL_STYLE = { display: 'flex', flex: 1, minWidth: 0 } as const;

/**
 * Names in one library often share a long prefix and differ only at the end, so
 * an ellipsis at the end would make the rows identical. `title` carries the full
 * name for anything still cut off.
 */
const HierarchyNodeName = memo<{ name: string }>(({ name }) => (
  <span style={LABEL_STYLE} title={name}>
    <MiddleEllipsis tailLength={TAIL_LENGTH} text={name} />
  </span>
));

HierarchyNodeName.displayName = 'HierarchyNodeName';

export default HierarchyNodeName;
