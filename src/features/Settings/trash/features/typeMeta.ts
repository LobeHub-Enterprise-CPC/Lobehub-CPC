import type { TrashResourceType } from '@lobechat/types';
import {
  BotIcon,
  ChartNoAxesColumnIcon,
  FileIcon,
  FileTextIcon,
  HashIcon,
  LayoutDashboardIcon,
  MessageSquareIcon,
} from 'lucide-react';

/** Icon per recycle-bin resource kind — mirrors the sidebar / recents glyphs. */
export const TRASH_TYPE_ICON: Record<TrashResourceType, typeof HashIcon> = {
  agent: BotIcon,
  file: FileIcon,
  document: FileTextIcon,
  dashboard: LayoutDashboardIcon,
  message: MessageSquareIcon,
  topic: HashIcon,
  widget: ChartNoAxesColumnIcon,
};

/** Order the type filter shows kinds in — most-deleted first. */
export const TRASH_TYPE_ORDER: TrashResourceType[] = [
  'file',
  'document',
  'topic',
  'agent',
  'message',
  'widget',
  'dashboard',
];
