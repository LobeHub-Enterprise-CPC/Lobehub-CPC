import { Empty, Flexbox, Spin, Text } from '@lobehub/ui';
import { useTranslation } from 'react-i18next';

import AsyncError from '@/components/AsyncError';
import type { EnterpriseKbEvent } from '@/services/enterpriseKnowledge';
import {
  enterpriseKnowledgeActions,
  enterpriseKnowledgeSelectors,
  useEnterpriseKnowledgeStore,
} from '@/store/enterpriseKnowledge';

const eventDetail = (
  event: EnterpriseKbEvent,
  level: (value: string) => string,
  change: (kind: 'added' | 'removed' | 'changed', name: string, value: string) => string,
) => {
  const rows: string[] = [];
  for (const key of ['added', 'removed', 'changed'] as const) {
    const values = event.detail[key];
    if (!Array.isArray(values)) continue;
    for (const entry of values) {
      if (typeof entry?.name !== 'string') continue;
      const value =
        key === 'changed' ? `${level(entry.from)} → ${level(entry.to)}` : level(entry.accessLevel);
      rows.push(change(key, entry.name, value));
    }
  }
  return rows;
};

export const AccessEvents = ({ knowledgeBaseId }: { knowledgeBaseId: string }) => {
  const { t, i18n } = useTranslation('knowledgeBase');
  const sync = enterpriseKnowledgeActions.useFetchEvents(knowledgeBaseId);
  const events = useEnterpriseKnowledgeStore(enterpriseKnowledgeSelectors.events(knowledgeBaseId));
  const level = (value: string) =>
    value === 'edit'
      ? t('enterprise.level.edit')
      : value === 'view'
        ? t('enterprise.level.view')
        : '';
  if (sync.error)
    return <AsyncError error={sync.error} variant="inline" onRetry={() => sync.revalidate()} />;
  if (!events) return <Spin />;
  if (events.length === 0) return <Empty description={t('enterprise.noEvents')} />;
  return (
    <Flexbox gap={20}>
      {events.map((event) => (
        <Flexbox gap={4} key={event.id}>
          <Text weight={500}>
            {String(event.action) === 'node_access_updated'
              ? t('enterprise.event.node_access_updated')
              : t(`enterprise.event.${event.action}`)}
          </Text>
          <Text type="secondary">
            {event.actor.name} · {new Date(event.createdAt).toLocaleString(i18n.language)}
          </Text>
          {(event.action === 'moved_in' || event.action === 'moved_out') && (
            <Text>
              {t('enterprise.move.eventDetail', {
                count: typeof event.detail.count === 'number' ? event.detail.count : 0,
                names: Array.isArray(event.detail.items)
                  ? event.detail.items
                      .map((item) => (typeof item?.name === 'string' ? item.name : ''))
                      .filter(Boolean)
                      .join('、')
                  : '',
              })}
            </Text>
          )}
          {String(event.action) === 'node_access_updated' && (
            <Text>
              {t('enterprise.node.eventDetail', {
                name: typeof event.detail.nodeName === 'string' ? event.detail.nodeName : '',
                from:
                  event.detail.fromMode === 'custom'
                    ? t('enterprise.node.custom')
                    : t('enterprise.node.inherit'),
                to:
                  event.detail.toMode === 'custom'
                    ? t('enterprise.node.custom')
                    : t('enterprise.node.inherit'),
              })}
            </Text>
          )}
          {eventDetail(event, level, (kind, name, value) =>
            t(`enterprise.eventDetail.${kind}`, { name, level: value }),
          ).map((detail, i) => (
            <Text key={i}>{detail}</Text>
          ))}
          {event.action === 'transferred' && (
            <Text>
              {t('enterprise.transferDetail', {
                from: typeof event.detail.fromName === 'string' ? event.detail.fromName : '',
                to: typeof event.detail.toName === 'string' ? event.detail.toName : '',
                count: typeof event.detail.fileCount === 'number' ? event.detail.fileCount : 0,
              })}
            </Text>
          )}
        </Flexbox>
      ))}
    </Flexbox>
  );
};
