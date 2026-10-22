'use client';

import { DEFAULT_USER_AVATAR } from '@lobechat/const';
import { Block, Button, Flexbox, Text } from '@lobehub/ui';
import React, { memo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHref } from 'react-router';

import AuthCard from '@/features/AuthCard';
import type { OidcClientMetadata, OidcInteractionDetailsResponse } from '@/types/oidc';

import { isDesktopClientId } from '../../desktopAuth';
import { isAutoApprovedClient } from '../consentPolicy';
import OAuthApplicationLogo from '../OAuthApplicationLogo';
import ThirdPartyNotice from '../ThirdPartyNotice';
import BuiltinConsent from './BuiltinConsent';

interface ClientProps {
  acceptanceReview?: OidcInteractionDetailsResponse['acceptanceReview'];
  account?: OidcInteractionDetailsResponse['account'];
  clientId: string;
  clientMetadata: OidcClientMetadata;
  onRetry: () => void;
  redirectUri?: string;
  scopes: string[];
  uid: string;
}

/**
 * Get the description for a scope
 */
function getScopeDescription(scope: string, t: any): string {
  return t(`consent.scope.${scope.replace(':', '-')}`, scope);
}

const ConsentClient = memo<ClientProps>(
  ({ acceptanceReview, account, uid, clientId, scopes, clientMetadata, onRetry }) => {
    const { t } = useTranslation(['oauth', 'auth', 'common']);
    const action = useHref('/oidc/consent');

    const [isLoading, setIsLoading] = useState(false);
    const consentInputRef = useRef<HTMLInputElement>(null);

    const clientDisplayName = clientMetadata?.clientName || clientId;
    const reviewDenied = acceptanceReview?.allowed === false;
    // The account block is the only thing the user can confirm the grant against,
    // so without anything identifiable the grant must not be submittable.
    const accountUnavailable = !account?.name?.trim() && !account?.email?.trim();

    if (isAutoApprovedClient(clientId)) {
      return <BuiltinConsent uid={uid} />;
    }

    return (
      <Flexbox gap={16} width={'min(100%,400px)'}>
        <OAuthApplicationLogo
          clientDisplayName={clientDisplayName}
          isFirstParty={clientMetadata.isFirstParty}
          logoUrl={clientMetadata.logo}
        />
        <AuthCard
          centered
          subtitle={t('consent.description', { clientName: clientDisplayName })}
          title={t('consent.title', { clientName: clientDisplayName })}
          footer={
            <form action={action} method="post" style={{ width: '100%' }}>
              <input name="uid" type="hidden" value={uid} />
              <input defaultValue="accept" name="consent" ref={consentInputRef} type="hidden" />
              <Flexbox gap={12}>
                {!reviewDenied && (
                  <Button
                    data-testid="oauth-consent-accept"
                    disabled={accountUnavailable}
                    htmlType="submit"
                    loading={isLoading}
                    size={'large'}
                    type="primary"
                    onClick={() => {
                      if (consentInputRef.current) consentInputRef.current.value = 'accept';
                      setIsLoading(true);
                    }}
                  >
                    {t('consent.buttons.accept')}
                  </Button>
                )}
                <Button
                  data-testid="oauth-consent-deny"
                  htmlType="submit"
                  size={'large'}
                  onClick={() => {
                    if (consentInputRef.current) consentInputRef.current.value = 'deny';
                  }}
                >
                  {t('consent.buttons.deny')}
                </Button>
              </Flexbox>
            </form>
          }
        >
          {isDesktopClientId(clientId) && (
            <Flexbox gap={8} style={{ marginBottom: 16 }}>
              <Alert showIcon description={t('consent.desktop.notice')} type={'warning'} />
              <Text fontSize={13} type={'secondary'}>
                {t('auth:organization.desktop.switchHint')}
              </Text>
            </Flexbox>
          )}
          {clientMetadata.isFirstParty === false && (
            <Flexbox style={{ marginBottom: 16 }}>
              <ThirdPartyNotice
                developerName={clientMetadata.developerName}
                policyUri={clientMetadata.policyUri}
              />
            </Flexbox>
          )}
          {acceptanceReview && (
            <Block padding={16} style={{ marginBottom: 16 }} variant={'outlined'}>
              <Text type={reviewDenied ? 'danger' : undefined} weight={500}>
                {reviewDenied
                  ? t('consent.acceptanceReview.denied')
                  : t('consent.acceptanceReview.target', { title: acceptanceReview.title ?? '' })}
              </Text>
            </Block>
          )}
          {accountUnavailable ? (
            <Alert
              description={t('consent.account.unavailable')}
              style={{ marginBottom: 16 }}
              type={'warning'}
              action={
                <Button size={'small'} onClick={onRetry}>
                  {t('common:retry')}
                </Button>
              }
            />
          ) : (
            account && (
              <Block padding={16} style={{ marginBottom: 16 }} variant={'outlined'}>
                <Flexbox gap={12}>
                  <Text fontSize={13} type={'secondary'}>
                    {t('consent.account.label')}
                  </Text>
                  <Flexbox horizontal align={'center'} gap={16}>
                    <Avatar
                      alt={account.name || account.email || ''}
                      avatar={account.avatar || DEFAULT_USER_AVATAR}
                      shape={'square'}
                      size={40}
                    />
                    <Flexbox gap={2}>
                      <Text fontSize={18} weight={500}>
                        {account.name || account.email || ''}
                      </Text>
                      {account.name && account.email && (
                        <Text fontSize={13} type={'secondary'}>
                          {account.email}
                        </Text>
                      )}
                    </Flexbox>
                  </Flexbox>
                </Flexbox>
              </Block>
            )
          )}
          <Text fontSize={16} type={'secondary'}>
            {t('consent.permissionsTitle')}
          </Text>
          <Flexbox gap={4} style={{ marginTop: 8 }} width={'100%'}>
            {scopes.map((scope) => (
              <Block key={scope} padding={16} variant={'filled'}>
                <Text>{getScopeDescription(scope, t)}</Text>
              </Block>
            ))}
          </Flexbox>
        </AuthCard>
      </Flexbox>
    );
  },
);

ConsentClient.displayName = 'ConsentClient';

export default ConsentClient;
