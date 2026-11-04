import { memo } from 'react';

const DEFAULT_TAIL_LENGTH = 8;

const HEAD_STYLE = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;
const TAIL_STYLE = { flex: 'none', whiteSpace: 'nowrap' } as const;

interface MiddleEllipsisProps {
  /** Characters kept after the ellipsis. */
  tailLength?: number;
  text: string;
}

/**
 * Ellipsizes the MIDDLE of a name instead of its tail, so an extension or a
 * serial stays readable: "2024-quarterly-report-final.pdf" truncates to
 * "2024-quarterly…final.pdf". Pure CSS: the head shrinks with an ellipsis while
 * the fixed tail stays pinned. Render it inside a flex row.
 */
const MiddleEllipsis = memo<MiddleEllipsisProps>(({ tailLength = DEFAULT_TAIL_LENGTH, text }) => {
  // Short names gain nothing from middle truncation — render them in one piece.
  if (text.length <= tailLength + 1) {
    return <span style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}>{text}</span>;
  }

  return (
    <>
      <span style={HEAD_STYLE}>{text.slice(0, -tailLength)}</span>
      <span style={TAIL_STYLE}>{text.slice(-tailLength)}</span>
    </>
  );
});

MiddleEllipsis.displayName = 'MiddleEllipsis';

export default MiddleEllipsis;
