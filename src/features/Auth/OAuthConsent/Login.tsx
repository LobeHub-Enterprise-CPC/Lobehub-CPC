'use client';

import { Avatar, Block, Button, Flexbox, Skeleton, Text } from '@lobehub/ui';
import React, { memo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useHref } from 'react-router';

import AuthCard from '@/features/AuthCard';
import { useSession } from '@/libs/better-auth/auth-client';
import type { OidcClientMetadata } from '@/types/oidc';

import OAuthApplicationLogo from './OAuthApplicationLogo';
import { redirectToSignIn } from './signInRedirect';

interface LoginConfirmProps {
  clientMetadata: OidcClientMetadata;
  uid: string;
}

const LoginConfirmClient = memo<LoginConfirmProps>(({ uid, clientMetadata }) => {
  const { t } = useTranslation(['oauth', 'common']);
  const action = useHref('/oidc/consent');

  const clientDisplayName = clientMetadata?.clientName || 'the application';

  const { data: session, error: sessionError, isPending, refetch: refetchSession } = useSession();
  const isUserStateInit = !isPending && !sessionError && !!session;
  const avatar = session?.user?.image || '';
  const nickName = session?.user?.name || '';

  // The login prompt can only be confirmed by a signed-in user; a visitor from a
  // client (e.g. Desktop) signs in first and comes back to this interaction. A
  // failed session lookup is not "signed out" — bounce nowhere and let the user
  // retry, otherwise an error would look like a sign-in wall.
  useEffect(() => {
    if (!isPending && !sessionError && !session) redirectToSignIn();
  }, [isPending, sessionError, session]);

  const [isLoading, setIsLoading] = React.useState(false);

  const titleText = t('login.title', { clientName: clientDisplayName });
  const descriptionText = t('login.description', { clientName: clientDisplayName });
  const buttonText = t('login.button'); // Or "Continue"

  return (
    <Flexbox gap={16} width={'min(100%,400px)'}>
      <OAuthApplicationLogo
        clientDisplayName={clientDisplayName}
        isFirstParty={clientMetadata.isFirstParty}
        logoUrl={clientMetadata.logo}
      />
      <AuthCard
        centered
        subtitle={descriptionText}
        title={titleText}
        footer={
          <form
            action={action}
            method="post"
            style={{ width: '100%' }}
            onSubmit={() => setIsLoading(true)}
          >
            {/* Adjust action URL */}
            <input name="uid" type="hidden" value={uid} />
            <input name="consent" type="hidden" value="accept" />
            {/* Single confirmation button */}
            <Button
              block
              data-testid="oauth-consent-accept"
              disabled={!isUserStateInit}
              htmlType="submit"
              loading={isLoading}
              size="large"
              type="primary"
            >
              {buttonText}
            </Button>
          </form>
        }
      >
        <Block padding={16} variant={'outlined'}>
          {sessionError ? (
            <Alert
              description={t('login.error.message')}
              type={'error'}
              action={
                <Button size={'small'} onClick={() => refetchSession()}>
                  {t('common:retry')}
                </Button>
              }
            />
          ) : isUserStateInit ? (
            <Flexbox horizontal align={'center'} gap={16}>
              <Avatar alt={nickName || ''} avatar={avatar} shape={'square'} size={40} />
              <Text fontSize={18} weight={500}>
                {nickName}
              </Text>
            </Flexbox>
          ) : (
            <Flexbox horizontal gap={16}>
              <Skeleton.Avatar shape={'square'} size={40} />
              <Skeleton height={36} />
            </Flexbox>
          )}
        </Block>
      </AuthCard>
    </Flexbox>
  );
});

LoginConfirmClient.displayName = 'LoginConfirmClient';

export default LoginConfirmClient;
