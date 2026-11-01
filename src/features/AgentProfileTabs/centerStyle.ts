import type { CSSProperties } from 'react';

import { isMobileSurface } from '@/utils/mobileSurface';

/**
 * Style for the host `NavHeader`'s `center` slot so the switcher sits on the
 * *header* midpoint with equal gaps on both sides — not merely centered within
 * the leftover flex track between the left/right slots (whose widths differ, so
 * that reads as space-between, not centered). Requires the NavHeader itself to
 * be `position: relative`. Shared by every page that hosts the switcher so the
 * three headers can't drift.
 */
export const AGENT_PROFILE_TABS_CENTER_STYLE: CSSProperties = {
  // Physical `left`/`top`, not `inset-inline-start`: the paired transform below
  // is physical (always shifts left/up), so a logical anchor would resolve to
  // `right: 50%` under an RTL locale while the transform still pulls left —
  // landing the switcher far left of center. Physical anchor + physical
  // transform compose correctly in both LTR and RTL.
  left: '50%',
  position: 'absolute',
  top: '50%',
  // Both axes: an absolutely-positioned flex child no longer inherits the row's
  // vertical centering, so center it explicitly rather than trusting top:auto.
  transform: 'translate(-50%, -50%)',
};

/**
 * A phone header is too narrow to center the switcher over the whole row: it
 * would cover the back button and the agent crumb. Mobile keeps it in the flow
 * between the left and right slots and lets it scroll sideways instead.
 */
const MOBILE_AGENT_PROFILE_TABS_CENTER_STYLE: CSSProperties = {
  minWidth: 0,
  overflowX: 'auto',
};

/** The `center` slot style for the header hosting the switcher on this surface. */
export const getAgentProfileTabsCenterStyle = (): CSSProperties =>
  isMobileSurface() ? MOBILE_AGENT_PROFILE_TABS_CENTER_STYLE : AGENT_PROFILE_TABS_CENTER_STYLE;
