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
import { unwrapESMModule } from '@/utils/esm/unwrapESMModule';
import { loadI18nNamespaceModule } from '@/utils/i18n/loadI18nNamespaceModule';

export const workbenchNamespaces = ['verify'] as const;

export const loadWorkbenchNamespace = async (lng: string, ns: string) => {
  const locale = normalizeLocale(lng);

  return unwrapESMModule(
    await loadI18nNamespaceModule({
      defaultLang: DEFAULT_LANG,
      lng: locale,
      normalizeLocale,
      ns,
    }),
  );
};

export const loadWorkbenchResources = async (lang?: string) => {
  const locale = normalizeLocale(lang);
  const entries = await Promise.all(
    workbenchNamespaces.map(async (ns) => [ns, await loadWorkbenchNamespace(locale, ns)] as const),
  );

  return Object.fromEntries(entries) as Record<string, unknown>;
};

export const createWorkbenchI18n = (lang?: string, bundledResources?: Record<string, unknown>) => {
  const locale = normalizeLocale(lang);
  const resources = bundledResources ? { [locale]: bundledResources } : undefined;

  // The acceptance namespace names the product inline ("Install LobeHub CLI"),
  // and this standalone SPA has no branding layer above the translations, so
  // register the same post-processor the main app uses. No-op under default
  // branding.
  let instance = i18next.createInstance();
  if (isBrandPostProcessorEnabled) instance = instance.use(brandPostProcessor);

  instance = instance.use(initReactI18next).use(resourcesToBackend(loadWorkbenchNamespace));
  let languageRequest = 0;

  return {
    changeLanguage: async (nextLocale: string) => {
      const request = ++languageRequest;
      // Register namespaces only for live changes: SSR must use its bundled resources synchronously.
      await instance.loadNamespaces([...workbenchNamespaces]);
      if (request !== languageRequest) return;

      await instance.loadLanguages(nextLocale);
      if (request !== languageRequest) return;

      await instance.changeLanguage(nextLocale);
    },
    init: (params: { initAsync?: boolean } = {}) =>
      instance.init({
        defaultNS: 'verify',
        fallbackLng: DEFAULT_LANG,
        initAsync: params.initAsync ?? true,
        interpolation: { escapeValue: false },
        keySeparator: false,
        lng: locale,
        ns: [],
        partialBundledLanguages: true,
        // Rewrite brand strings baked into the locale copy (white-label only).
        ...(isBrandPostProcessorEnabled ? { postProcess: [BRAND_POST_PROCESSOR] } : {}),
        react: {
          bindI18nStore: 'added',
          useSuspense: false,
        },
        resources,
        showSupportNotice: false,
      }),
    instance,
  };
};
