import { withCurrentTenantPath } from '@lobechat/business-tenant/client';
import { ActionIcon, Button, DropdownMenu, Flexbox, Icon, toast } from '@lobehub/ui';
import { InfoIcon, MoreVerticalIcon, Trash2 } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';
import { buildLibraryPath, buildPagePath } from '@/features/ResourceManager/utils/resourcePath';
import { useAgentStore } from '@/store/agent';
import { useServerConfigStore } from '@/store/serverConfig';
import { KnowledgeType } from '@/types/knowledgeBase';

interface ActionsProps {
  accessRevoked?: boolean;
  enabled?: boolean;
  id: string;
  type: KnowledgeType;
}

const Actions = memo<ActionsProps>(({ id, type, enabled, accessRevoked }) => {
  const { t } = useTranslation('chat');

  const mobile = useServerConfigStore((s) => s.isMobile);
  const activeWorkspaceSlug = useActiveWorkspaceSlug();
  const [
    addFilesToAgent,
    addKnowledgeBasesToAgent,
    removeFilesFromAgent,
    removeKnowledgeBasesFromAgent,
  ] = useAgentStore((s) => [
    s.addFilesToAgent,
    s.addKnowledgeBaseToAgent,
    s.removeFileFromAgent,
    s.removeKnowledgeBaseFromAgent,
  ]);

  const [loading, setLoading] = useState(false);

  const assignKnowledge = async () => {
    if (accessRevoked) return;
    setLoading(true);
    try {
      if (type === KnowledgeType.KnowledgeBase) {
        await addKnowledgeBasesToAgent(id);
      } else {
        await addFilesToAgent([id], true);
      }
    } catch {
      toast.error(t('operationFailed', { ns: 'common' }));
    } finally {
      setLoading(false);
    }
  };

  const removeKnowledge = async () => {
    setLoading(true);
    try {
      if (type === KnowledgeType.KnowledgeBase) {
        await removeKnowledgeBasesFromAgent(id);
      } else {
        await removeFilesFromAgent(id);
      }
    } finally {
      setLoading(false);
    }
  };

  if (accessRevoked)
    return (
      <Button loading={loading} size="small" onClick={removeKnowledge}>
        {t('knowledgeBase.library.action.remove')}
      </Button>
    );

  return (
    <Flexbox horizontal align={'center'}>
      {enabled ? (
        <DropdownMenu
          placement="bottomRight"
          items={[
            {
              icon: <Icon icon={InfoIcon} />,
              key: 'detail',
              label: t('knowledgeBase.library.action.detail'),
              onClick: () => {
                window.open(
                  withCurrentTenantPath(
                    type === KnowledgeType.KnowledgeBase
                      ? buildLibraryPath(id, activeWorkspaceSlug)
                      : buildPagePath(id, activeWorkspaceSlug),
                  ),
                );
              },
            },
            {
              danger: true,
              icon: <Icon icon={Trash2} />,
              key: 'remove',
              label: t('knowledgeBase.library.action.remove'),
              onClick: removeKnowledge,
            },
          ]}
        >
          <ActionIcon
            icon={MoreVerticalIcon}
            loading={loading}
            title={t('more', { ns: 'common' })}
          />
        </DropdownMenu>
      ) : (
        <Button
          loading={loading}
          size={mobile ? 'small' : undefined}
          type={'primary'}
          onClick={assignKnowledge}
        >
          {t('knowledgeBase.library.action.add')}
        </Button>
      )}
    </Flexbox>
  );
});

export default Actions;
