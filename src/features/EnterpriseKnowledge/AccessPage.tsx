import type { KnowledgeBaseItem } from '@lobechat/types';
import { Alert, Button, Empty, Flexbox, Segmented, Select, Spin, Text, toast } from '@lobehub/ui';
import isEqual from 'fast-deep-equal';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import NotFound from '@/components/404';
import AsyncError from '@/components/AsyncError';
import NavHeader from '@/features/NavHeader';
import WideScreenContainer from '@/features/WideScreenContainer';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import type {
  EnterpriseKbAccessState,
  EnterpriseKbGrant,
  EnterpriseKbGrantInput,
} from '@/services/enterpriseKnowledge';
import {
  enterpriseKnowledgeActions,
  enterpriseKnowledgeSelectors,
  useEnterpriseKnowledgeStore,
} from '@/store/enterpriseKnowledge';
import { isTrpcErrorCode } from '@/utils/trpcError';

import { AccessEvents } from './AccessEvents';
import { DirectoryPicker } from './DirectoryPicker';
import { useAccessDraftGuard } from './useAccessDraftGuard';

const grantInputs = (grants: EnterpriseKbGrant[]): EnterpriseKbGrantInput[] =>
  grants.map(({ principalId, principalType, accessLevel }) => ({
    principalId,
    principalType,
    accessLevel,
  }));

export const EnterpriseAccessPage = ({ library }: { library: KnowledgeBaseItem }) => {
  const { t } = useTranslation(['knowledgeBase', 'common']);
  const navigate = useWorkspaceAwareNavigate();
  const id = library.id;
  const sync = enterpriseKnowledgeActions.useFetchAccess(
    library.enterprise?.accessLevel === 'owner' ? id : null,
  );
  enterpriseKnowledgeActions.useFetchDirectory(
    library.enterprise?.accessLevel === 'owner' ? '' : null,
  );
  const directory = useEnterpriseKnowledgeStore(enterpriseKnowledgeSelectors.directory(''));
  const roots = new Set(directory?.departments.filter((d) => d.parentId === null).map((d) => d.id));
  const saved = useEnterpriseKnowledgeStore(enterpriseKnowledgeSelectors.access(id));
  const [draft, setDraft] = useState<EnterpriseKbAccessState | null>(null);
  const [tab, setTab] = useState('access');
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const current = draft ?? saved;
  const dirty = !!draft && !isEqual(grantInputs(draft.grants), grantInputs(saved?.grants ?? []));
  useAccessDraftGuard(dirty);
  const estimateParams =
    current && tab === 'access'
      ? { grants: grantInputs(current.grants), knowledgeBaseId: id }
      : null;
  const estimateSync = enterpriseKnowledgeActions.useFetchEstimate(estimateParams);
  const estimate = useEnterpriseKnowledgeStore(
    enterpriseKnowledgeSelectors.estimate(estimateParams),
  );

  const changeGrants = (grants: EnterpriseKbGrant[]) => {
    if (!current || saving) return;
    setDraft({ grants, version: current.version });
  };
  const discard = () => {
    setDraft(null);
    setAdding(false);
  };
  const changeTab = async (next: string) => {
    if (saving || next === tab) return;
    if (dirty) {
      const { confirmModal } = await import('@lobehub/ui');
      confirmModal({
        cancelText: t('enterprise.keepEditing'),
        content: t('enterprise.discardDescription'),
        okText: t('enterprise.discard'),
        title: t('enterprise.unsaved'),
        onOk: () => {
          discard();
          setTab(next);
        },
      });
    } else setTab(next);
  };
  const submit = async () => {
    if (
      !current ||
      !dirty ||
      saving ||
      !estimate ||
      estimateSync.error ||
      estimateSync.isValidating
    )
      return;
    setSaving(true);
    try {
      await enterpriseKnowledgeActions.updateAccess(
        id,
        current.version,
        grantInputs(current.grants),
      );
      discard();
      toast.success(t('enterprise.saved'));
    } catch (error) {
      if (isTrpcErrorCode(error, 'CONFLICT')) {
        discard();
        toast.warning(t('enterprise.conflict'));
      } else {
        toast.error(t('operationFailed', { ns: 'common' }));
      }
    } finally {
      setSaving(false);
    }
  };

  if (library.enterprise?.accessLevel !== 'owner' || isTrpcErrorCode(sync.error, 'NOT_FOUND'))
    return <NotFound />;
  return (
    <Flexbox flex={1} height="100%" style={{ minHeight: 0 }}>
      <NavHeader
        left={
          <Flexbox horizontal align="center" gap={12}>
            <Button size="small" type="text" onClick={() => navigate(`/resource/library/${id}`)}>
              {library.name}
            </Button>
            <Text weight={500}>{t('enterprise.access')}</Text>
          </Flexbox>
        }
      />
      <Flexbox flex={1} style={{ overflowY: 'auto' }}>
        <WideScreenContainer>
          <Flexbox gap={24} padding={24}>
            <Segmented
              value={tab}
              options={[
                { label: t('enterprise.access'), value: 'access' },
                { label: t('enterprise.events'), value: 'events' },
              ]}
              onChange={(value) => void changeTab(String(value))}
            />
            {tab === 'events' ? (
              <AccessEvents knowledgeBaseId={id} />
            ) : (
              <>
                <Text type="secondary">{t('enterprise.accessHint')}</Text>
                <Text>{t('enterprise.ownerLabel', { name: library.enterprise.ownerName })}</Text>
                {sync.error ? (
                  <AsyncError
                    error={sync.error}
                    variant="inline"
                    onRetry={() => sync.revalidate()}
                  />
                ) : !current ? (
                  <Spin />
                ) : (
                  <>
                    {current.grants.length === 0 ? (
                      <Empty description={t('enterprise.noGrants')} />
                    ) : (
                      <Flexbox gap={16}>
                        {current.grants.map((grant, index) => (
                          <Flexbox
                            horizontal
                            align="center"
                            gap={8}
                            key={`${grant.principalType}:${grant.principalId}`}
                            style={{ flexWrap: 'wrap' }}
                          >
                            <Flexbox flex={1} style={{ minWidth: 160 }}>
                              <Text>
                                {grant.deleted
                                  ? t(
                                      grant.principalType === 'department'
                                        ? 'enterprise.deletedDepartment'
                                        : 'enterprise.deletedMember',
                                    )
                                  : grant.principalType === 'department' &&
                                      roots.has(grant.principalId)
                                    ? t('enterprise.everyone')
                                    : grant.name}
                              </Text>
                              <Text type="secondary">
                                {grant.departmentName ||
                                  (grant.memberCount !== null
                                    ? t('enterprise.departmentMembers', {
                                        count: grant.memberCount,
                                      })
                                    : '')}
                              </Text>
                            </Flexbox>
                            <Select
                              aria-label={t('enterprise.levelLabel', { name: grant.name })}
                              disabled={saving || grant.deleted}
                              value={grant.accessLevel}
                              options={[
                                { label: t('enterprise.level.view'), value: 'view' },
                                { label: t('enterprise.level.edit'), value: 'edit' },
                              ]}
                              onChange={(value) =>
                                changeGrants(
                                  current.grants.map((g, i) =>
                                    i === index
                                      ? { ...g, accessLevel: value as 'view' | 'edit' }
                                      : g,
                                  ),
                                )
                              }
                            />
                            <Button
                              danger
                              disabled={saving}
                              type="text"
                              onClick={() =>
                                changeGrants(current.grants.filter((_, i) => i !== index))
                              }
                            >
                              {t('enterprise.remove')}
                            </Button>
                          </Flexbox>
                        ))}
                      </Flexbox>
                    )}
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
                            title={t('enterprise.impact', {
                              lost: estimate.lost,
                              downgraded: estimate.downgraded,
                            })}
                          />
                        )}
                      </Flexbox>
                    )}
                    <Flexbox horizontal gap={8} justify="flex-end" paddingBlock={12}>
                      <Button disabled={!dirty || saving} onClick={discard}>
                        {t('enterprise.discard')}
                      </Button>
                      <Button
                        loading={saving}
                        type="primary"
                        disabled={
                          !dirty || !estimate || !!estimateSync.error || estimateSync.isValidating
                        }
                        onClick={submit}
                      >
                        {t('save', { ns: 'common' })}
                      </Button>
                    </Flexbox>
                  </>
                )}
              </>
            )}
          </Flexbox>
        </WideScreenContainer>
      </Flexbox>
    </Flexbox>
  );
};
