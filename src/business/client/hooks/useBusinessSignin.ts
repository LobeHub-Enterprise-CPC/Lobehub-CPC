import { type ReactNode, useEffect, useState } from 'react';

export interface BusinessSSOProvider {
  displayName: string;
  id: string;
  logoUrl: string | null;
  protocol: 'oidc' | 'oauth2';
}

export const useBusinessSignin = () => {
  const [configuration, setConfiguration] = useState<{
    managed: boolean;
    providers: BusinessSSOProvider[];
  }>();
  const [ssoError, setSsoError] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setSsoError(false);
    setConfiguration(undefined);
    void fetch('/webapi/auth/sso-providers', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('SSO configuration unavailable');
        const data = await response.json();
        if (!controller.signal.aborted) setConfiguration(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSsoError(true);
      });
    return () => controller.abort();
  }, [reload]);

  return {
    businessElement: null as ReactNode,
    getAdditionalData: async () => {
      return {};
    },
    getCaptchaTokenOnError: async (_error: unknown) => undefined as string | null | undefined,
    getFetchOptions: async () => undefined as Record<string, unknown> | undefined,
    preSocialSigninCheck: async () => {
      return true;
    },
    managedSSO: configuration?.managed,
    reloadSSO: () => setReload((value) => value + 1),
    ssoError,
    ssoLoaded: Boolean(configuration),
    ssoProviders: configuration?.providers ?? [],
  };
};
