'use client';

import { FluentEmoji } from '@lobehub/ui';
import { Result, Text } from '@lobehub/ui/base-ui';
import React, { memo } from 'react';
import { useTranslation } from 'react-i18next';

interface ClientProps {
  error: {
    message?: string;
    messageKey?: string;
    title?: string;
    titleKey?: string;
    values?: Record<string, string>;
  };
}

const ConsentClientError = memo<ClientProps>(({ error }) => {
  const { t } = useTranslation('oauth');

  const title = error.titleKey
    ? t(error.titleKey as any, { ...error.values, defaultValue: error.titleKey })
    : error.title;
  const message = error.messageKey
    ? t(error.messageKey as any, { ...error.values, defaultValue: error.messageKey })
    : error.message;

  return (
    <Result
      icon={<FluentEmoji emoji={'🥵'} size={96} type={'anim'} />}
      status={'error'}
      title={
        <Text fontSize={32} weight={'bold'}>
          {title}
        </Text>
      }
    >
      {/* Result wraps subTitle in <p>: block content (Text renders a div) must stay outside it */}
      <Text fontSize={16} style={{ maxWidth: '36ch' }} type="secondary">
        {message}
      </Text>
    </Result>
  );
});

ConsentClientError.displayName = 'ConsentClientError';

export default ConsentClientError;
