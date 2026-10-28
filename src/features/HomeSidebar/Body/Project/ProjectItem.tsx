'use client';

import { ActionIcon, Avatar, DropdownMenu } from '@lobehub/ui';
import { FolderClosedIcon, MoreHorizontalIcon } from 'lucide-react';
import { memo } from 'react';

import { brandIcon } from '@/components/BrandIcon';
import NavItem from '@/features/NavPanel/components/NavItem';
import WorkspaceLink from '@/features/Workspace/WorkspaceLink';
import type { ProjectListItem } from '@/store/project';

import { useProjectMenuItems } from './useProjectMenuItems';

interface ProjectItemProps {
  project: ProjectListItem;
}

const ProjectItem = memo<ProjectItemProps>(({ project }) => {
  const { canManage, deleting, menuItems } = useProjectMenuItems(project);

  return (
    <WorkspaceLink to={`/project/${project.slug ?? project.id}`}>
      <NavItem
        contextMenuItems={canManage ? menuItems : undefined}
        disabled={deleting}
        title={project.name}
        actions={
          canManage ? (
            <DropdownMenu items={menuItems}>
              <ActionIcon
                icon={brandIcon('action.more', MoreHorizontalIcon)}
                loading={deleting}
                size={'small'}
              />
            </DropdownMenu>
          ) : undefined
        }
        // `avatar` is an emoji or image URL, not a component: `Icon` would pass it to
        // createElement as a tag name and crash the whole page.
        icon={
          project.avatar ? (
            <Avatar avatar={project.avatar} shape={'square'} size={18} />
          ) : (
            brandIcon('project.folder', FolderClosedIcon)
          )
        }
      />
    </WorkspaceLink>
  );
});

ProjectItem.displayName = 'ProjectItem';

export default ProjectItem;
