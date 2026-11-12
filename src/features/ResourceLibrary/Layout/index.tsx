'use client';

import { Button, Empty, Flexbox, toast } from '@lobehub/ui';
import { type FC, useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useParams } from 'react-router';

import AsyncError from '@/components/AsyncError';
import RegisterHotkeys from '@/features/ResourceLibrary/RegisterHotkeys';
import { useKnowledgeBaseItem } from '@/features/ResourceManager/hooks/useKnowledgeItem';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { subscribeKnowledgeAccessRefused } from '@/services/knowledgeAccessEvents';
import { useKnowledgeBaseStore } from '@/store/library';
import { isForbiddenError } from '@/utils/forbiddenError';
import { isTrpcErrorCode } from '@/utils/trpcError';

import Sidebar from './Sidebar';
import { styles } from './style';

const LibraryLayout: FC = () => {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation(['file', 'knowledgeBase']);
  const navigate = useWorkspaceAwareNavigate();
  // Same SWR key as the page content's fetch, so this costs no extra request.
  const { data, error, isConfirmed } = useKnowledgeBaseItem(id || '');
  const openedEnterprise = useRef<string | null>(null);
  const leaving = useRef(false);
  useEffect(() => {
    if (isConfirmed && data?.enterprise && id) openedEnterprise.current = id;
  }, [isConfirmed, data, id]);
  useLayoutEffect(() => {
    if (!id || !data?.enterprise) return;
    return subscribeKnowledgeAccessRefused(() => {
      void useKnowledgeBaseStore
        .getState()
        .refreshKnowledgeBaseItem(id)
        .catch(() => {});
    });
  }, [id, data?.enterprise]);
  const unavailable =
    isTrpcErrorCode(error, 'NOT_FOUND') ||
    (!data && openedEnterprise.current === id && !isConfirmed);
  useEffect(() => {
    if (!unavailable || openedEnterprise.current !== id || leaving.current) return;
    leaving.current = true;
    toast.warning(t('enterprise.accessLost', { ns: 'knowledgeBase' }));
    void useKnowledgeBaseStore.getState().refreshKnowledgeBaseList();
    navigate('/resource', { replace: true });
  }, [unavailable, id, navigate, t]);
  if (unavailable) return <Empty description={t('enterprise.notFound', { ns: 'knowledgeBase' })} />;

  // A restricted KB (resource-permission `use` level) 403s for members. Catch
  // it at the layout so the route shows one error page in the content area
  // (the nav slot stays an idle skeleton), instead of the sidebar and the
  // content each rendering their own error card. Retrying can never succeed,
  // so the action slot carries the way back instead of a retry button.
  if (error && isForbiddenError(error)) {
    return (
      <AsyncError
        error={error}
        variant={'page'}
        action={
          <Button size={'small'} onClick={() => navigate('/resource', { replace: true })}>
            {t('library.backToResources')}
          </Button>
        }
      />
    );
  }

  return (
    <>
      <Sidebar />
      <Flexbox className={styles.mainContainer} flex={1} height={'100%'}>
        <Outlet />
      </Flexbox>
      <RegisterHotkeys />
    </>
  );
};

export default LibraryLayout;
