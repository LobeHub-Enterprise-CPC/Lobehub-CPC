'use client';

import { Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import NotFound from '@/components/404';

import OAuthGuard from '../OAuthGuard';
import ClientError from './ClientError';
import Consent from './Consent';
import InteractionDetailsSkeleton from './InteractionDetailsSkeleton';
import Login from './Login';
import { InteractionDetailsError, useInteractionDetails } from './useInteractionDetails';

const RetryableError = memo<{
  messageKey: string;
  onRetry: () => void;
  titleKey: string;
}>(({ messageKey, onRetry, titleKey }) => {
  const { t } = useTranslation(['oauth', 'common']);

  return (
    <Flexbox align={'center'} gap={16}>
      <ClientError error={{ messageKey, titleKey }} />
      <Button onClick={onRetry}>{t('common:retry')}</Button>
    </Flexbox>
  );
});

RetryableError.displayName = 'OAuthRetryableError';

const renderError = (error: unknown, onRetry: () => void): ReactNode => {
  if (error instanceof InteractionDetailsError) {
    if (error.status === 404) return <NotFound />;

    if (error.status === 409)
      return (
        <ClientError
          error={{
            messageKey: 'consent.error.unsupportedInteraction.message',
            titleKey: 'consent.error.unsupportedInteraction.title',
            values: { promptName: error.promptName || '' },
          }}
        />
      );

    // The session lookup failed on the server; the session itself may be fine.
    if (error.status === 503)
      return (
        <RetryableError
          messageKey={'consent.error.sessionUnavailable.message'}
          titleKey={'consent.error.sessionUnavailable.title'}
          onRetry={onRetry}
        />
      );

    if (error.status === 400 && error.message === 'session_changed')
      return (
        <ClientError
          error={{
            messageKey: 'consent.error.sessionChanged.message',
            titleKey: 'consent.error.sessionChanged.title',
          }}
        />
      );

    if (error.status === 400)
      return (
        <ClientError
          error={{
            messageKey: 'consent.error.sessionInvalid.message',
            titleKey: 'consent.error.sessionInvalid.title',
          }}
        />
      );

    return (
      <ClientError
        error={{
          messageKey: 'consent.error.unknown.message',
          titleKey: 'consent.error.title',
        }}
      />
    );
  }

  const message = error instanceof Error ? error.message : undefined;

  return (
    <ClientError
      error={{
        message,
        messageKey: message ? undefined : 'consent.error.unknown.message',
        titleKey: 'consent.error.title',
      }}
    />
  );
};

const InteractionContent = memo(() => {
  const { uid } = useParams<{ uid: string }>();
  const { data, error, isLoading, mutate } = useInteractionDetails(uid);
  const retry = () => void mutate();

  if (!uid) return <NotFound />;
  if (error) return renderError(error, retry);
  if (isLoading || !data) return <InteractionDetailsSkeleton />;

  if (data.prompt === 'login') return <Login clientMetadata={data.clientMetadata} uid={data.uid} />;

  return (
    <Consent
      acceptanceReview={data.acceptanceReview}
      account={data.account}
      clientId={data.clientId}
      clientMetadata={data.clientMetadata}
      redirectUri={data.redirectUri}
      scopes={data.scopes}
      uid={data.uid}
      onRetry={retry}
    />
  );
});

InteractionContent.displayName = 'OAuthInteractionContent';

const OAuthConsent = () => (
  <OAuthGuard>
    <InteractionContent />
  </OAuthGuard>
);

export default OAuthConsent;
