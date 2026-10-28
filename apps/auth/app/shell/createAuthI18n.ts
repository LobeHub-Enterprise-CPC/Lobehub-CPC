import i18next from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';

import { DEFAULT_LANG } from '@/const/locale';
import {
  BRAND_POST_PROCESSOR,
  brandPostProcessor,
  isBrandPostProcessorEnabled,
} from '@/locales/brandPostProcessor';
import { normalizeLocale } from '@/locales/resources';

import type { AuthResourceBundle } from './i18nScript';
import { AUTH_NAMESPACES } from './i18nScript';
import { loadAuthNamespace } from './loadAuthNamespace';

interface CreateAuthI18nOptions {
  locale: string;
  resources: AuthResourceBundle;
}

// The served locale is bundled into the document and initialised synchronously,
// so prerender and hydration render identical markup; anything the language
// switcher reaches afterwards arrives through the on-demand backend.
export const createAuthI18n = ({ locale, resources }: CreateAuthI18nOptions) => {
  const lng = normalizeLocale(locale);
  // Sign-in, API-key and OAuth-consent copy names the product inline across the
  // `auth` / `common` / `oauth` / `marketAuth` namespaces, and this standalone
  // SPA has no branding layer above the translations, so register the same
  // post-processor the main app's AuthShell uses. No-op under default branding.
  let instance = i18next.createInstance();
  if (isBrandPostProcessorEnabled) instance = instance.use(brandPostProcessor);

  instance = instance.use(initReactI18next).use(resourcesToBackend(loadAuthNamespace));

  // With `ns: []` and the served language bundled, i18next treats every
  // namespace as loaded and never asks the backend — switching has to fetch.
  instance.on('languageChanged', (next) => {
    if (normalizeLocale(next) === lng) return;
    void instance.reloadResources([normalizeLocale(next)], [...AUTH_NAMESPACES]);
  });

  return {
    init: () =>
      instance.init({
        defaultNS: ['auth', 'common', 'error'],
        fallbackLng: DEFAULT_LANG,
        initAsync: false,
        interpolation: { escapeValue: false },
        keySeparator: false,
        lng,
        ns: [],
        partialBundledLanguages: true,
        // Rewrite brand strings baked into the locale copy (white-label only).
        ...(isBrandPostProcessorEnabled ? { postProcess: [BRAND_POST_PROCESSOR] } : {}),
        react: {
          bindI18nStore: 'added',
          useSuspense: false,
        },
        resources: { [lng]: resources },
        showSupportNotice: false,
      }),
    instance,
  };
};
