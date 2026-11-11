import type { TreeDataNode } from '@lobehub/ui';
import { Button, Empty, Flexbox, Input, Spin, Text, Tree } from '@lobehub/ui';
import { useDebounce } from 'ahooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncError from '@/components/AsyncError';
import type { EnterpriseKbGrant } from '@/services/enterpriseKnowledge';
import {
  enterpriseKnowledgeActions,
  enterpriseKnowledgeSelectors,
  useEnterpriseKnowledgeStore,
} from '@/store/enterpriseKnowledge';

interface DirectoryPickerProps {
  disabled?: boolean;
  grants: EnterpriseKbGrant[];
  onAdd: (grants: EnterpriseKbGrant[]) => void;
  ownerId?: string;
}

export const DirectoryPicker = ({ grants, disabled, ownerId, onAdd }: DirectoryPickerProps) => {
  const { t } = useTranslation('knowledgeBase');
  const [keyword, setKeyword] = useState('');
  const search = useDebounce(keyword.trim(), { wait: 300 });
  const directorySync = enterpriseKnowledgeActions.useFetchDirectory('');
  const searchSync = enterpriseKnowledgeActions.useFetchDirectory(search || null);
  const directory = useEnterpriseKnowledgeStore(enterpriseKnowledgeSelectors.directory(''));
  const found = useEnterpriseKnowledgeStore(enterpriseKnowledgeSelectors.directory(search));
  const selectedDepartments = grants
    .filter((g) => g.principalType === 'department')
    .map((g) => g.principalId);
  const selected = new Set(grants.map((g) => `${g.principalType}:${g.principalId}`));
  const departments = directory?.departments ?? [];
  const byId = new Map(departments.map((d) => [d.id, d]));
  const covered = (id: string) => {
    const seen = new Set<string>();
    for (
      let parent = byId.get(id)?.parentId;
      parent && !seen.has(parent);
      parent = byId.get(parent)?.parentId
    ) {
      seen.add(parent);
      if (selectedDepartments.includes(parent)) return true;
    }
    return false;
  };
  const build = (parentId: string | null, visited: Set<string>): TreeDataNode[] =>
    departments
      .filter(
        (d) =>
          d.parentId === parentId || (parentId === null && !!d.parentId && !byId.has(d.parentId)),
      )
      .filter((d) => !visited.has(d.id))
      .map((d) => ({
        key: d.id,
        title: (
          <Text>
            {d.parentId === null ? t('enterprise.everyone') : d.name}{' '}
            <Text as="span" type="secondary">
              {covered(d.id)
                ? t('enterprise.departmentCovered')
                : t('enterprise.departmentMembers', { count: d.memberCount })}
            </Text>
          </Text>
        ),
        children: build(d.id, new Set([...visited, d.id])),
      }));
  return (
    <Flexbox gap={12}>
      <Text type="secondary">{t('enterprise.departmentHint')}</Text>
      {directorySync.error ? (
        <AsyncError
          error={directorySync.error}
          variant="inline"
          onRetry={() => directorySync.revalidate()}
        />
      ) : !directory ? (
        <Spin />
      ) : (
        <Tree
          checkStrictly
          checkable
          defaultExpandAll
          checkedKeys={selectedDepartments}
          disabled={disabled}
          treeData={build(null, new Set())}
          onCheck={(keys) => {
            const ids = new Set(keys.map(String));
            const retained = grants.filter(
              (g) => g.principalType !== 'department' || ids.has(g.principalId),
            );
            const added = departments
              .filter((d) => ids.has(d.id) && !selected.has(`department:${d.id}`))
              .map((d) => ({
                accessLevel: 'view' as const,
                deleted: false,
                memberCount: d.memberCount,
                name: d.name,
                principalId: d.id,
                principalType: 'department' as const,
              }));
            onAdd([...retained, ...added]);
          }}
        />
      )}
      <Input
        aria-label={t('enterprise.searchMembers')}
        disabled={disabled}
        placeholder={t('enterprise.searchPlaceholder')}
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
      />
      {search &&
        (searchSync.error ? (
          <AsyncError
            error={searchSync.error}
            variant="inline"
            onRetry={() => searchSync.revalidate()}
          />
        ) : !found ? (
          <Spin />
        ) : found.users.length === 0 ? (
          <Empty description={t('enterprise.noMembers')} />
        ) : (
          found.users
            .filter((user) => user.id !== ownerId)
            .map((user) => (
              <Flexbox horizontal align="center" gap={12} justify="space-between" key={user.id}>
                <Flexbox>
                  <Text>{user.name}</Text>
                  <Text type="secondary">{user.departmentName || user.email}</Text>
                </Flexbox>
                <Button
                  disabled={disabled || selected.has(`user:${user.id}`)}
                  size="small"
                  onClick={() =>
                    onAdd([
                      ...grants,
                      {
                        accessLevel: 'view',
                        deleted: false,
                        departmentName: user.departmentName,
                        memberCount: null,
                        name: user.name,
                        principalId: user.id,
                        principalType: 'user',
                      },
                    ])
                  }
                >
                  {t(selected.has(`user:${user.id}`) ? 'enterprise.added' : 'enterprise.add')}
                </Button>
              </Flexbox>
            ))
        ))}
    </Flexbox>
  );
};
