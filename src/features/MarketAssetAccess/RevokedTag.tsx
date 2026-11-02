import { Tag, Tooltip } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

/** Marks an installed Market tool the enterprise no longer makes available to this member. */
const RevokedTag = memo(() => {
  const { t } = useTranslation('setting');
  return (
    <Tooltip title={t('marketAssetAccess.revokedHint')}>
      <Tag color={'warning'} size={'small'} style={{ flexShrink: 0 }}>
        {t('marketAssetAccess.revoked')}
      </Tag>
    </Tooltip>
  );
});

RevokedTag.displayName = 'MarketAssetRevokedTag';

export default RevokedTag;
