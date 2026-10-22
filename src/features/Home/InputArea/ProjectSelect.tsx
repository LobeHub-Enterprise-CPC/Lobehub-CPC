'use client';

import type { DropdownItem} from '@lobehub/ui';
import { Button, createStaticStyles, DropdownMenu, Icon, Text } from '@lobehub/ui';
import { FolderClosedIcon, FolderOpenIcon, PlusIcon } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { openCreateProjectModal } from '@/features/Projects/CreateProjectModal';
import { useHomeStore } from '@/store/home';
import { useCurrentProjectList, useProjectStore } from '@/store/project';

const styles = createStaticStyles(({ css, cssVar }) => ({
  trigger: css`
    gap: 6px;

    min-width: 0;
    max-width: 200px;
    height: 28px;
    padding-inline: 8px;
    border: 0;

    color: ${cssVar.colorTextSecondary};

    background: transparent;

    &[data-popup-open] {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  triggerSelected: css`
    color: ${cssVar.colorText};
  `,
}));

/**
 * Files the next home conversation under a project. The choice lasts for one
 * conversation: sending (or "New chat") clears it.
 */
const ProjectSelect = memo(() => {
  const { t } = useTranslation('project');
  const projects = useCurrentProjectList();
  useProjectStore((s) => s.useFetchProjectList)();
  const [projectId, setProjectId] = useHomeStore((s) => [
    s.homeSelectedProjectId,
    s.setHomeSelectedProjectId,
  ]);
  const selected = projects.find((project) => project.id === projectId);

  const items = useMemo<DropdownItem[]>(
    () => [
      ...projects.map((project) => ({
        checked: project.id === projectId,
        icon: <Icon icon={FolderClosedIcon} />,
        key: project.id,
        label: project.name,
        onCheckedChange: () => setProjectId(project.id),
        type: 'checkbox' as const,
      })),
      ...(projects.length > 0 ? [{ type: 'divider' as const }] : []),
      ...(projectId
        ? [{ key: 'clear', label: t('picker.clear'), onClick: () => setProjectId(undefined) }]
        : []),
      {
        icon: <Icon icon={PlusIcon} />,
        key: 'create',
        label: t('create.title'),
        onClick: () => openCreateProjectModal({ onCreated: (project) => setProjectId(project.id) }),
      },
    ],
    [projects, projectId, setProjectId, t],
  );

  return (
    <DropdownMenu items={items} placement={'bottomLeft'}>
      <Button
        className={selected ? `${styles.trigger} ${styles.triggerSelected}` : styles.trigger}
        data-brand-slot={'home-project-select'}
        icon={<Icon icon={selected ? FolderOpenIcon : FolderClosedIcon} size={16} />}
        type={'text'}
      >
        <Text ellipsis style={{ color: 'inherit', minWidth: 0 }}>
          {selected?.name ?? t('picker.placeholder')}
        </Text>
      </Button>
    </DropdownMenu>
  );
});

ProjectSelect.displayName = 'HomeProjectSelect';

export default ProjectSelect;
