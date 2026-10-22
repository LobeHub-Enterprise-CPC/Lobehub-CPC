'use client';

import { ActionIcon, Avatar, type DropdownItem, DropdownMenu, Flexbox, Icon } from '@lobehub/ui';
import {
  FolderClosedIcon,
  FolderOpenIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SquareArrowOutUpRightIcon,
} from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import FlatMode from '@/features/AgentSidebar/Topic/TopicListContent/FlatMode';
import {
  TopicListRevealContext,
  TopicListScopeContext,
} from '@/features/AgentSidebar/Topic/TopicListScope';
import NavItem from '@/features/NavPanel/components/NavItem';
import { useProjectTopicReveal } from '@/features/Projects/WorkingDirectories/useProjectTopicReveal';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { useHomeStore } from '@/store/home';
import type { ProjectListItem } from '@/store/project';

import { useProjectMenuItems } from './useProjectMenuItems';

interface ProjectGroupItemProps {
  project: ProjectListItem;
}

/**
 * A project row with its conversations listed under it. The row folds the list;
 * "+" starts a home conversation filed under the project, and the project page
 * is one entry of the "..." menu rather than the row's click.
 */
const ProjectGroupItem = memo<ProjectGroupItemProps>(({ project }) => {
  const { t } = useTranslation('project');
  const navigate = useWorkspaceAwareNavigate();
  const setHomeSelectedProjectId = useHomeStore((s) => s.setHomeSelectedProjectId);
  const [expanded, setExpanded] = useState(true);
  const { deleting, menuItems } = useProjectMenuItems(project);
  const scope = useMemo(() => ({ nested: true, projectId: project.id }), [project.id]);
  const reveal = useProjectTopicReveal(project.id);

  const items: DropdownItem[] = [
    {
      icon: <Icon icon={SquareArrowOutUpRightIcon} />,
      key: 'open',
      label: t('sidebar.openProject'),
      onClick: () => navigate(`/project/${project.slug ?? project.id}`),
    },
    ...(menuItems?.length ? [{ type: 'divider' as const }, ...menuItems] : []),
  ];

  const startConversation = () => {
    setHomeSelectedProjectId(project.id);
    navigate('/');
  };

  return (
    <Flexbox gap={1}>
      <NavItem
        contextMenuItems={items}
        disabled={deleting}
        title={project.name}
        actions={
          <Flexbox horizontal align={'center'} gap={2}>
            <DropdownMenu items={items}>
              <ActionIcon
                icon={MoreHorizontalIcon}
                loading={deleting}
                size={'small'}
                title={t('list.moreActions')}
                onClick={(e) => e.stopPropagation()}
              />
            </DropdownMenu>
            <ActionIcon
              icon={PlusIcon}
              size={'small'}
              title={t('sidebar.newConversation')}
              onClick={(e) => {
                e.stopPropagation();
                startConversation();
              }}
            />
          </Flexbox>
        }
        // `avatar` is an emoji or image URL, not a component: `Icon` would pass it to
        // createElement as a tag name and crash the whole page.
        icon={
          project.avatar ? (
            <Avatar avatar={project.avatar} shape={'square'} size={18} />
          ) : expanded ? (
            FolderOpenIcon
          ) : (
            FolderClosedIcon
          )
        }
        onClick={() => setExpanded((value) => !value)}
      />
      {expanded && (
        <TopicListScopeContext value={scope}>
          <TopicListRevealContext value={reveal}>
            <FlatMode />
          </TopicListRevealContext>
        </TopicListScopeContext>
      )}
    </Flexbox>
  );
});

ProjectGroupItem.displayName = 'ProjectGroupItem';

export default ProjectGroupItem;
