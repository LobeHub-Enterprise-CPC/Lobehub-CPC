import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';

import { isScheduledTasksWorkspace } from './isScheduledTasksWorkspace';

/**
 * Pages that own the whole content area, so the shell neither renders the
 * second-level panel nor reserves its width: the scheduled-task workspace, and
 * the showcase market, whose kinds are tabs in its own top bar.
 */
export const hidesNavPanel = (pathname: string, search: string) =>
  isScheduledTasksWorkspace(pathname, search) ||
  (COMMUNITY_SHOWCASE_LAYOUT && /\/community(?:\/|$)/.test(pathname));
