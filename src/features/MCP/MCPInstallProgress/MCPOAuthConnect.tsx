import { Flexbox } from '@lobehub/ui';
import { Button, Text } from '@lobehub/ui/base-ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useToolStore } from '@/store/tool';
import { openConnectorOAuthPopup } from '@/utils/connectorOAuth';

export default function MCPOAuthConnect({ identifier }: { identifier: string }) {
  const { t } = useTranslation('plugin');
  const [loading, setLoading] = useState(false);
  const installMCPPlugin = useToolStore((s) => s.installMCPPlugin);
  const cancelInstallMCPPlugin = useToolStore((s) => s.cancelInstallMCPPlugin);

  const connect = async () => {
    // Must run in the click, before manifest fetching or any other async work.
    const popup = openConnectorOAuthPopup();
    setLoading(true);
    try {
      await installMCPPlugin(identifier, { authorize: true, oauthPopup: popup, resume: true });
    } finally {
      popup?.close();
      setLoading(false);
    }
  };

  return (
    <Flexbox gap={12} padding={12}>
      <Text>{t('mcpInstall.oauthDescription')}</Text>
      <Flexbox horizontal gap={8} justify={'flex-end'}>
        <Button onClick={() => cancelInstallMCPPlugin(identifier)}>
          {t('cancel', { ns: 'common' })}
        </Button>
        <Button loading={loading} type={'primary'} onClick={connect}>
          {t('mcpInstall.oauthConnect')}
        </Button>
      </Flexbox>
    </Flexbox>
  );
}
