import type { EnterpriseKnowledgeBaseInfo } from '@lobechat/types';
import { Tag, type TagProps } from '@lobehub/ui';
import { useTranslation } from 'react-i18next';

export const EnterpriseAccessBadge = ({
  enterprise,
  accessRevoked,
  size,
  style,
}: Pick<TagProps, 'size' | 'style'> & {
  accessRevoked?: boolean;
  enterprise?: EnterpriseKnowledgeBaseInfo;
}) => {
  const { t } = useTranslation('knowledgeBase');
  if (!enterprise && !accessRevoked) return null;
  return (
    <Tag color={accessRevoked ? 'warning' : undefined} size={size} style={style}>
      {t(accessRevoked ? 'enterprise.revoked' : `enterprise.level.${enterprise!.accessLevel}`)}
    </Tag>
  );
};
