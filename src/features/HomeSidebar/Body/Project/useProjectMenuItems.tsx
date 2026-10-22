import type { MenuProps } from '@lobehub/ui';
import { confirmModal, Icon, toast } from '@lobehub/ui';
import { PencilIcon, TrashIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { openRenameProjectModal } from '@/features/Projects/RenameProjectModal';
import type { ProjectListItem } from '@/store/project';
import { useProjectStore } from '@/store/project';
import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';

/** Rename and delete for a project row; empty for a project the viewer does not own. */
export const useProjectMenuItems = (project: ProjectListItem) => {
  const { t } = useTranslation(['project', 'common']);
  const [deleting, setDeleting] = useState(false);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const currentUserId = useUserStore(userProfileSelectors.userId);
  const canManage = currentUserId === project.userId;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteProject(project.id);
      toast.success(t('list.deleteSuccess', { name: project.name }));
    } catch (error) {
      console.error('Failed to delete project', error);
      toast.error(t('list.deleteError'));
      setDeleting(false);
    }
  };

  const menuItems: MenuProps['items'] = canManage
    ? [
        {
          icon: <Icon icon={PencilIcon} />,
          key: 'rename',
          label: t('rename.action'),
          onClick: () => openRenameProjectModal(project),
        },
        { type: 'divider' },
        {
          danger: true,
          icon: <Icon icon={TrashIcon} />,
          key: 'delete',
          label: t('list.deleteAction'),
          onClick: () =>
            confirmModal({
              cancelText: t('cancel', { ns: 'common' }),
              content: t('list.deleteConfirmDescription', { name: project.name }),
              okButtonProps: { danger: true },
              okText: t('delete', { ns: 'common' }),
              onOk: () => void handleDelete(),
              title: t('list.deleteConfirmTitle'),
            }),
        },
      ]
    : [];

  return { canManage, deleting, menuItems };
};
