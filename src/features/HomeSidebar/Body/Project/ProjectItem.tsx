'use client';

import { BRANDING_ICONS } from '@lobechat/business-const/icons';
import { ActionIcon, DropdownMenu } from '@lobehub/ui';
import { FolderClosedIcon, MoreHorizontalIcon } from 'lucide-react';
import { memo } from 'react';

import { brandIcon } from '@/components/BrandIcon';
import NavItem from '@/features/NavPanel/components/NavItem';
import ProjectAvatar from '@/features/Projects/ProjectAvatar';
import WorkspaceLink from '@/features/Workspace/WorkspaceLink';
import type { ProjectListItem } from '@/store/project';

import { useProjectMenuItems } from './useProjectMenuItems';

// `avatar` is an emoji or image URL, not a component: `Icon` would pass it to
// createElement as a tag name and crash the whole page.
// A project without a logo shows the deployment's folder icon when its brand
// ships one; otherwise the generated avatar.
export const projectIcon = (project: Pick<ProjectListItem, 'avatar' | 'name'>) =>
  !project.avatar && BRANDING_ICONS['project.folder'] ? (
    brandIcon('project.folder', FolderClosedIcon)
  ) : (
    <ProjectAvatar avatar={project.avatar} name={project.name} size={18} />
  );

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
        icon={projectIcon(project)}
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
      />
    </WorkspaceLink>
  );
});

ProjectItem.displayName = 'ProjectItem';

export default ProjectItem;
