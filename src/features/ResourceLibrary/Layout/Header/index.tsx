'use client';

import { Button, Flexbox } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { useLibraryPermission } from '@/features/EnterpriseKnowledge/useLibraryPermission';
import SideBarHeaderLayout from '@/features/NavPanel/SideBarHeaderLayout';
import AddButton from '@/features/ResourceManager/components/Header/AddButton';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';

import LibraryHead from './LibraryHead';
import LibrarySearchBar from './LibrarySearchBar';
import { useActiveLibraryId } from './useActiveLibraryId';

const Header = memo(() => {
  const id = useActiveLibraryId();
  const navigate = useWorkspaceAwareNavigate();
  const { enterprise, canManageAccess } = useLibraryPermission('edit_own_content', id);
  const { t } = useTranslation('common');
  return (
    <>
      <SideBarHeaderLayout
        backTo="/resource"
        left={<LibraryHead id={id} />}
        breadcrumb={[
          {
            href: `/resource/library/${id}`,
            title: t('tab.resource'),
          },
        ]}
      />
      {/*
        Search + create stay reachable from the sidebar no matter what the
        content area shows. The Explorer toolbar carries the same actions, but
        it is covered as soon as a page or file is opened, which left no way
        to add or find anything without backing out of the document first.

        This "+" sits beside the library name, so it creates at the library's
        root rather than in whatever folder the URL happens to be in; each
        folder row carries its own "+" for creating inside that folder.
      */}
      <Flexbox horizontal align={'center'} gap={8} paddingBlock={'0 8px'} paddingInline={8}>
        <LibrarySearchBar />
        <AddButton iconOnly rootLevel />
      </Flexbox>
      {enterprise && canManageAccess && (
        <Flexbox horizontal gap={4} paddingBlock={4} paddingInline={8} wrap="wrap">
          <Button
            size="small"
            type="text"
            onClick={() => navigate(`/resource/library/${id}/permission`)}
          >
            {t('enterprise.access', { ns: 'knowledgeBase' })}
          </Button>
          <Button size="small" type="text" onClick={() => navigate('/settings/trash')}>
            {t('enterprise.trash', { ns: 'knowledgeBase' })}
          </Button>
        </Flexbox>
      )}
      <Flexbox />
    </>
  );
});

export default Header;
