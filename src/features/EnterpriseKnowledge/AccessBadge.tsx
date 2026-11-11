import type { EnterpriseKnowledgeBaseInfo } from '@lobechat/types';
import { Tag } from '@lobehub/ui';
import { useTranslation } from 'react-i18next';

export const EnterpriseAccessBadge = ({
  enterprise,
  accessRevoked,
}: {
  accessRevoked?: boolean;
  enterprise?: EnterpriseKnowledgeBaseInfo;
}) => {
  const { t } = useTranslation('knowledgeBase');
  if (!enterprise && !accessRevoked) return null;
  return (
    <Tag color={accessRevoked ? 'warning' : undefined}>
      {t(accessRevoked ? 'enterprise.revoked' : `enterprise.level.${enterprise!.accessLevel}`)}
    </Tag>
  );
};
