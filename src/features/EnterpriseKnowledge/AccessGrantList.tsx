import { Button, Empty, Flexbox, Select, Text } from '@lobehub/ui';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { EnterpriseKbGrant } from '@/services/enterpriseKnowledge';
import {
  enterpriseKnowledgeSelectors,
  useEnterpriseKnowledgeStore,
} from '@/store/enterpriseKnowledge';

interface AccessGrantListProps {
  disabled?: boolean;
  grants: EnterpriseKbGrant[];
  onChange?: (grants: EnterpriseKbGrant[]) => void;
  renderHint?: (grant: EnterpriseKbGrant) => ReactNode;
}

/** The library and node editors share principal identity, deleted states and grant controls. */
export const AccessGrantList = ({
  disabled,
  grants,
  onChange,
  renderHint,
}: AccessGrantListProps) => {
  const { t } = useTranslation('knowledgeBase');
  const directory = useEnterpriseKnowledgeStore(enterpriseKnowledgeSelectors.directory(''));
  const roots = new Set(directory?.departments.filter((d) => d.parentId === null).map((d) => d.id));
  if (grants.length === 0) return <Empty description={t('enterprise.noGrants')} />;
  return (
    <Flexbox gap={16}>
      {grants.map((grant, index) => (
        <Flexbox
          horizontal
          align="center"
          gap={8}
          key={`${grant.principalType}:${grant.principalId}`}
          wrap="wrap"
        >
          <Flexbox flex={1} style={{ minWidth: 160 }}>
            <Text>
              {grant.deleted
                ? t(
                    grant.principalType === 'department'
                      ? 'enterprise.deletedDepartment'
                      : 'enterprise.deletedMember',
                  )
                : grant.principalType === 'department' && roots.has(grant.principalId)
                  ? t('enterprise.everyone')
                  : grant.name}
            </Text>
            <Text type="secondary">
              {grant.departmentName ||
                (grant.memberCount !== null
                  ? t('enterprise.departmentMembers', { count: grant.memberCount })
                  : '')}
            </Text>
            {renderHint?.(grant)}
          </Flexbox>
          {onChange ? (
            <>
              <Select
                aria-label={t('enterprise.levelLabel', { name: grant.name })}
                disabled={disabled || grant.deleted}
                value={grant.accessLevel}
                options={[
                  { label: t('enterprise.level.view'), value: 'view' },
                  { label: t('enterprise.level.edit'), value: 'edit' },
                ]}
                onChange={(value) =>
                  onChange(
                    grants.map((g, i) =>
                      i === index ? { ...g, accessLevel: value as 'view' | 'edit' } : g,
                    ),
                  )
                }
              />
              <Button
                danger
                disabled={disabled}
                type="text"
                onClick={() => onChange(grants.filter((_, i) => i !== index))}
              >
                {t('enterprise.remove')}
              </Button>
            </>
          ) : (
            <Text>{t(`enterprise.level.${grant.accessLevel}`)}</Text>
          )}
        </Flexbox>
      ))}
    </Flexbox>
  );
};
