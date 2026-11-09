import { COMMUNITY_SHOWCASE_LAYOUT } from '@lobechat/business-const';

import { SkillNavKey } from './types';

/**
 * First page of the comment list. Header (Reviews stat) and the Reviews tab
 * must query with the SAME params so SWR dedupes them into one request — the
 * header count doubles as a prefetch for the tab.
 */
export const FIRST_COMMENTS_PAGE_QUERY = {
  order: 'desc',
  page: 1,
  sort: 'createdAt',
} as const;

/**
 * Detail tabs this deployment offers. The showcase layout installs a skill only
 * through the in-app Install button, and its desktop page has no install guide,
 * so the mobile page drops the Install tab as well: that guide tells people to
 * install with the upstream market CLI and curl a lobehub.com URL.
 */
export const SKILL_NAV_KEYS: readonly SkillNavKey[] = COMMUNITY_SHOWCASE_LAYOUT
  ? [SkillNavKey.Overview, SkillNavKey.Reviews, SkillNavKey.Info]
  : [SkillNavKey.Overview, SkillNavKey.Install, SkillNavKey.Reviews, SkillNavKey.Info];

/** A tab this deployment offers; old links to a dropped tab open the overview. */
export const resolveSkillNavKey = (tab?: SkillNavKey): SkillNavKey =>
  tab && SKILL_NAV_KEYS.includes(tab) ? tab : SkillNavKey.Overview;
