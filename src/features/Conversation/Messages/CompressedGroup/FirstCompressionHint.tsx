import { Button, cssVar, Flexbox } from '@lobehub/ui';
import { X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import {
  dismissFirstCompression,
  isFirstCompressionVisible,
  subscribeFirstCompression,
} from '@/utils/firstCompressionHint';

import { useConversationStore } from '../../store';

export default function FirstCompressionHint({ id }: { id: string }) {
  const { t } = useTranslation(['chat', 'common']);
  const topicId = useConversationStore((s) => s.context.topicId);
  const visible = useSyncExternalStore(
    subscribeFirstCompression,
    () => isFirstCompressionVisible(topicId, id),
    () => false,
  );

  if (!visible || !topicId) return null;
  return (
    <Flexbox horizontal align={'center'} gap={4}>
      <span style={{ color: cssVar.colorTextDescription, fontSize: 12 }}>
        {t('compression.firstHint')}
      </span>
      <Button
        aria-label={t('common:close')}
        icon={X}
        size={'small'}
        type={'text'}
        onClick={() => dismissFirstCompression(topicId)}
      />
    </Flexbox>
  );
}
