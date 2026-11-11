import { Tag } from '@lobehub/ui';
import { useTranslation } from 'react-i18next';

export const EnterpriseCustomAccessBadge = ({ custom }: { custom?: boolean }) => {
  const { t } = useTranslation('knowledgeBase');
  return custom ? <Tag>{t('enterprise.node.custom')}</Tag> : null;
};
