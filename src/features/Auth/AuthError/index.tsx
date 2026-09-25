'use client';

import { BRANDING_EMAIL } from '@lobechat/business-const';
import { Flexbox, Icon } from '@lobehub/ui';
import { Button, Text } from '@lobehub/ui/base-ui';
import { cssVar } from 'antd-style';
import { Mail } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';

import AuthCard from '@/features/AuthCard';

const normalizeErrorCode = (code?: string | null) =>
  (code || 'UNKNOWN').trim().toUpperCase().replaceAll('-', '_');

const AuthErrorPage = memo(() => {
  const { t } = useTranslation('authError');
  const [searchParams] = useSearchParams();
  const error = searchParams.get('error');

  const code = normalizeErrorCode(error);
  const accessDenied = code === 'EMAIL_NOT_ALLOWED' || code === 'SSO_ACCESS_DENIED';
  const description = t(`codes.${code}`, { defaultValue: t('codes.UNKNOWN') });

  return (
    <AuthCard
      subtitle={description}
      title={t(accessDenied ? 'accessDenied.title' : 'title')}
      footer={
        <Flexbox gap={12} justify="center" wrap="wrap">
          <Link to="/signin">
            <Button block size={'large'} type="primary">
              {t(accessDenied ? 'actions.signIn' : 'actions.retry')}
            </Button>
          </Link>
          {!accessDenied && (
            <>
              <a href={'/'}>
                <Button block size={'large'}>
                  {t('actions.home')}
                </Button>
              </a>
              {BRANDING_EMAIL.support && (
                <a href={`mailto:${BRANDING_EMAIL.support}`}>
                  <Button block icon={<Icon icon={Mail} />} type="text">
                    {BRANDING_EMAIL.support}
                  </Button>
                </a>
              )}
            </>
          )}
        </Flexbox>
      }
    >
      {accessDenied && (
        <Flexbox paddingBlock={8}>
          <Text type="secondary">{t('accessDenied.help')}</Text>
        </Flexbox>
      )}
      <Text
        type={'secondary'}
        style={{
          fontFamily: cssVar.fontFamilyCode,
        }}
      >
        {t('errorCode')}: {code}
      </Text>
    </AuthCard>
  );
});

AuthErrorPage.displayName = 'AuthErrorPage';

export default AuthErrorPage;
