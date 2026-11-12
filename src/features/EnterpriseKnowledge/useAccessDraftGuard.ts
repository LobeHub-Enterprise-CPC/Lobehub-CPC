import { confirmModal } from '@lobehub/ui';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

/** Policy edits never auto-save while leaving: the owner must approve their impact. */
export const useAccessDraftGuard = (dirty: boolean) => {
  const { t } = useTranslation(['knowledgeBase', 'common']);
  const blocker = useBlocker(dirty);
  const latest = useRef(blocker);
  latest.current = blocker;
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    const modal = confirmModal({
      cancelText: t('enterprise.keepEditing'),
      content: t('enterprise.discardDescription'),
      okText: t('enterprise.discard'),
      onCancel: () => latest.current.reset?.(),
      onOk: () => latest.current.proceed?.(),
      title: t('enterprise.unsaved'),
    });
    return () => {
      modal.destroy();
    };
  }, [blocker.state, t]);
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [dirty]);
};
