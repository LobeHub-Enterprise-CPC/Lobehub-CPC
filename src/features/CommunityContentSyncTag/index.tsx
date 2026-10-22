'use client';

import { Icon, Tooltip } from '@lobehub/ui';
import { Tag } from '@lobehub/ui/base-ui';
import { Link2OffIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { type MarketContentSync } from '@/types/discover';

interface ContentSyncTagProps {
  /**
   * The resource's own `contentSync` as Market reported it (for a group detail,
   * `.group.contentSync`). Never derive it from owner or `isOfficial`.
   */
  contentSync?: MarketContentSync;
}

/**
 * Marks a platform-synced copy that has been cut loose from its original.
 *
 * Only `{ detached: true }` draws anything. Still synced, never bound
 * (`null`) and "Market did not say" (`undefined`) are the common cases and
 * deserve no badge.
 */
const ContentSyncTag = memo<ContentSyncTagProps>(({ contentSync }) => {
  const { t } = useTranslation('discover');

  if (contentSync?.detached !== true) return null;

  return (
    <Tooltip title={t('contentSync.detachedDesc')}>
      <Tag color="default" data-testid="content-sync-detached" icon={<Icon icon={Link2OffIcon} />}>
        {t('contentSync.detached')}
      </Tag>
    </Tooltip>
  );
});

ContentSyncTag.displayName = 'ContentSyncTag';

export default ContentSyncTag;
