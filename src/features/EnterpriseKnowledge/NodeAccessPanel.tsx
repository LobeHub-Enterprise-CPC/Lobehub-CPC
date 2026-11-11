import type { KnowledgeBaseItem } from '@lobechat/types';
import {
  Alert,
  Button,
  confirmModal,
  Flexbox,
  Modal,
  Segmented,
  Spin,
  Text,
  toast,
} from '@lobehub/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncError from '@/components/AsyncError';
import { useResourceManagerFetchFolderBreadcrumb } from '@/features/ResourceManager/store';
import type { EnterpriseKbGrant, NodeAccessParams } from '@/services/enterpriseKnowledge';
import {
  enterpriseKnowledgeActions,
  enterpriseKnowledgeSelectors,
  useEnterpriseKnowledgeStore,
} from '@/store/enterpriseKnowledge';
import { useFileStore } from '@/store/file';
import { useTreeStore } from '@/store/tree';
import { isTrpcErrorCode } from '@/utils/trpcError';

import { AccessGrantList } from './AccessGrantList';
import { DirectoryPicker } from './DirectoryPicker';
import {
  changeNodeAccessMode,
  grantInputs,
  isNodeAccessDirty,
  type NodeAccessDraft,
} from './nodeAccessDraft';
import { useAccessDraftGuard } from './useAccessDraftGuard';

interface NodeAccessPanelProps extends NodeAccessParams {
  library: KnowledgeBaseItem;
  onClose: () => void;
  parentId?: string | null;
}

/** Controlled dismissal keeps Escape, backdrop and close-button on the same draft guard. */
export const NodeAccessPanel = ({
  knowledgeBaseId,
  nodeId,
  library,
  parentId,
  onClose,
}: NodeAccessPanelProps) => {
  const { t } = useTranslation(['knowledgeBase', 'common']);
  const params = { knowledgeBaseId, nodeId };
  const parentSlug = useTreeStore(
    (s) =>
      Object.values(s.children)
        .flat()
        .find((item) => item.id === parentId)?.slug,
  );
  const breadcrumb = useResourceManagerFetchFolderBreadcrumb(parentSlug);
  const sync = enterpriseKnowledgeActions.useFetchNodeAccess(params);
  const saved = useEnterpriseKnowledgeStore(enterpriseKnowledgeSelectors.nodeAccess(params));
  enterpriseKnowledgeActions.useFetchDirectory('');
  const path = [
    library.name,
    ...(breadcrumb.data.length
      ? breadcrumb.data.map((item) => item.name)
      : parentId !== null
        ? ['…']
        : []),
    saved?.node.name ?? '',
  ].join(' › ');
  const parentParams =
    saved?.mode === 'custom' && saved.inheritedFrom.id
      ? { knowledgeBaseId, nodeId: saved.inheritedFrom.id }
      : null;
  const parentSync = enterpriseKnowledgeActions.useFetchNodeAccess(parentParams);
  const parent = useEnterpriseKnowledgeStore(enterpriseKnowledgeSelectors.nodeAccess(parentParams));
  const rootId = saved?.mode === 'custom' && !saved.inheritedFrom.id ? knowledgeBaseId : null;
  const rootSync = enterpriseKnowledgeActions.useFetchAccess(rootId);
  const root = useEnterpriseKnowledgeStore(enterpriseKnowledgeSelectors.access(knowledgeBaseId));
  const inherited =
    saved?.mode === 'inherit' ? saved.grants : parentParams ? parent?.grants : root?.grants;
  const inheritedError = parentParams ? parentSync.error : rootId ? rootSync.error : undefined;
  const [draft, setDraft] = useState<NodeAccessDraft | null>(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const current = draft ?? saved;
  const dirty = !!saved && !!draft && isNodeAccessDirty(saved, draft);
  useAccessDraftGuard(dirty || saving);
  const estimateParams = current
    ? { ...params, grants: grantInputs(current.grants), mode: current.mode }
    : null;
  const estimateSync = enterpriseKnowledgeActions.useFetchNodeEstimate(estimateParams);
  const estimate = useEnterpriseKnowledgeStore(
    enterpriseKnowledgeSelectors.nodeEstimate(estimateParams),
  );
  const confirmDiscard = (action: () => void) => {
    if (saving) return;
    if (!dirty) return action();
    confirmModal({
      cancelText: t('enterprise.keepEditing'),
      content: t('enterprise.discardDescription'),
      okText: t('enterprise.discard'),
      title: t('enterprise.unsaved'),
      onOk: action,
    });
  };
  const changeMode = (mode: NodeAccessDraft['mode']) => {
    if (!current || !saved || saving || mode === current.mode || !inherited) return;
    const apply = () => {
      setDraft(changeNodeAccessMode(current, mode, inherited));
      setAdding(false);
    };
    if (mode === 'inherit') {
      confirmModal({
        cancelText: t('cancel', { ns: 'common' }),
        okText: t('enterprise.node.inherit'),
        title: t('enterprise.node.inheritConfirmTitle'),
        content: t('enterprise.node.inheritConfirm', { name: saved.inheritedFrom.name }),
        onOk: apply,
      });
    } else apply();
  };
  const changeGrants = (grants: EnterpriseKbGrant[]) => {
    if (current?.mode === 'custom' && !saving) setDraft({ ...current, grants });
  };
  const submit = async () => {
    if (
      !dirty ||
      !current ||
      saving ||
      !estimate ||
      estimateSync.error ||
      estimateSync.isValidating
    )
      return;
    setSaving(true);
    try {
      await enterpriseKnowledgeActions.updateNodeAccess({
        ...params,
        grants: grantInputs(current.grants),
        mode: current.mode,
        version: current.version,
      });
      setDraft(null);
      setAdding(false);
      // Refresh both rendered list and the sidebar, including cached descendants that inherit.
      const refreshed = await Promise.allSettled([
        useFileStore.getState().refreshFileList(),
        ...Object.keys(useTreeStore.getState().children).map((id) =>
          useTreeStore.getState().revalidate(id),
        ),
      ]);
      toast.success(t('enterprise.saved'));
      if (refreshed.some((result) => result.status === 'rejected'))
        toast.warning(t('enterprise.node.refreshFailed'));
    } catch (error) {
      if (isTrpcErrorCode(error, 'CONFLICT')) {
        setDraft(null);
        setAdding(false);
        toast.warning(t('enterprise.conflict'));
      } else toast.error(t('operationFailed', { ns: 'common' }));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      footer={null}
      title={t('enterprise.node.title', { name: saved?.node.name ?? '' })}
      width="min(720px, 95vw)"
      onCancel={() => confirmDiscard(onClose)}
    >
      <Flexbox gap={20} padding={16} style={{ maxHeight: '75vh', overflowY: 'auto' }}>
        {sync.error ? (
          <AsyncError error={sync.error} variant="inline" onRetry={() => sync.revalidate()} />
        ) : !saved || !current ? (
          <Spin />
        ) : (
          <>
            <Segmented
              disabled={saving || !inherited || !!inheritedError}
              value={current.mode}
              options={[
                { label: t('enterprise.node.inherit'), value: 'inherit' },
                { label: t('enterprise.node.custom'), value: 'custom' },
              ]}
              onChange={(mode) => changeMode(mode as NodeAccessDraft['mode'])}
            />
            <Text type="secondary">
              {current.mode === 'inherit'
                ? t('enterprise.node.inheritedFrom', { name: saved.inheritedFrom.name })
                : t('enterprise.node.customHint')}
            </Text>
            {inheritedError && (
              <AsyncError
                error={inheritedError}
                variant="inline"
                onRetry={() => (parentParams ? parentSync.revalidate() : rootSync.revalidate())}
              />
            )}
            <AccessGrantList
              disabled={saving}
              grants={current.mode === 'inherit' ? (inherited ?? current.grants) : current.grants}
              renderHint={(grant) =>
                estimate?.pathOnly?.some(
                  (p) =>
                    p.principalId === grant.principalId && p.principalType === grant.principalType,
                ) ? (
                  <Text type="secondary">{t('enterprise.node.pathOnly', { path })}</Text>
                ) : null
              }
              onChange={current.mode === 'custom' ? changeGrants : undefined}
            />
            {current.mode === 'custom' && (
              <>
                <Button disabled={saving} onClick={() => setAdding(!adding)}>
                  {t(adding ? 'enterprise.closePicker' : 'enterprise.addPrincipals')}
                </Button>
                {adding && (
                  <DirectoryPicker
                    disabled={saving}
                    grants={current.grants}
                    ownerId={library.userId}
                    onAdd={changeGrants}
                  />
                )}
              </>
            )}
            {estimateSync.error ? (
              <AsyncError
                error={estimateSync.error}
                variant="inline"
                onRetry={() => estimateSync.revalidate()}
              />
            ) : !estimate ? (
              <Spin />
            ) : (
              <Flexbox gap={12}>
                <Text>
                  {t('enterprise.estimate', {
                    total: estimate.total,
                    edit: estimate.edit,
                    view: estimate.view,
                  })}
                </Text>
                {!!(estimate.lost || estimate.downgraded) && (
                  <Alert
                    type="warning"
                    title={t('enterprise.node.impact', {
                      lost: estimate.lost,
                      downgraded: estimate.downgraded,
                      name: saved.node.name,
                    })}
                  />
                )}
              </Flexbox>
            )}
          </>
        )}
        <Flexbox horizontal gap={8} justify="flex-end">
          <Button disabled={saving} onClick={() => confirmDiscard(onClose)}>
            {t('cancel', { ns: 'common' })}
          </Button>
          <Button
            loading={saving}
            type="primary"
            disabled={
              !dirty ||
              !estimate ||
              !!estimateSync.error ||
              estimateSync.isValidating ||
              !!sync.error
            }
            onClick={submit}
          >
            {t('save', { ns: 'common' })}
          </Button>
        </Flexbox>
      </Flexbox>
    </Modal>
  );
};
