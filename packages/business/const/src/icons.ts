/**
 * Icon replacements a deployment ships with its brand, keyed by the place the
 * icon sits (see `BrandIconKey`). Each entry is SVG child markup drawn in
 * `currentColor` for its `viewBox`, so it follows the surrounding text colour
 * and dark mode. A key without an entry keeps the app's own icon.
 *
 * Markup rather than components keeps this package free of a React or icon
 * library dependency; `brandIcon` in the app turns an entry into a component
 * that drops in wherever a lucide icon is accepted.
 */
export interface BrandIconSvg {
  svg: string;
  viewBox: string;
}

export type BrandIconKey =
  | 'action.add'
  | 'action.close'
  | 'action.more'
  | 'action.search'
  | 'agent.connectExternal'
  | 'agent.create'
  | 'agent.market'
  | 'chat.approvalManual'
  | 'chat.chevronDown'
  | 'chat.send'
  | 'chat.voice'
  | 'device.computer'
  | 'group.addMember'
  | 'group.members'
  | 'group.settings'
  | 'nav.community'
  | 'nav.communityActive'
  | 'nav.help'
  | 'nav.home'
  | 'nav.homeActive'
  | 'nav.image'
  | 'nav.imageActive'
  | 'nav.memory'
  | 'nav.notification'
  | 'nav.pages'
  | 'nav.resource'
  | 'nav.resourceActive'
  | 'nav.tasks'
  | 'nav.tasksActive'
  | 'panel.toggle'
  | 'project.create'
  | 'project.folder'
  | 'project.folderOpen'
  | 'topic.new'
  | 'topic.overview'
  | 'topic.share'
  | 'topic.terminal'
  | 'workspace.document'
  | 'workspace.skill';

export const BRANDING_ICONS: Partial<Record<BrandIconKey, BrandIconSvg>> = {};
