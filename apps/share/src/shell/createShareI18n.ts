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

export type ShareResources = Record<string, Record<string, string>>;

// `error` is preloaded rather than fetched on demand: the boundary that needs
// it renders when something already failed, and a chunk-load failure is exactly
// the case where the client can never fetch the dictionary to correct itself.
export const shareNamespaces = ['chat', 'error', 'pageShare'] as const;

export const loadShareNamespace = async (lng: string, ns: string) => {
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

export const loadShareResources = async (lang?: string) => {
  const locale = normalizeLocale(lang);
  const entries = await Promise.all(
    shareNamespaces.map(async (ns) => [ns, await loadShareNamespace(locale, ns)] as const),
  );

  return Object.fromEntries(entries) as ShareResources;
};

export const createShareI18n = (lang?: string, bundledResources?: ShareResources) => {
  const locale = normalizeLocale(lang);
  const resources = bundledResources ? { [locale]: bundledResources } : undefined;

  // This instance renders locale copy with no other branding layer above it, so
  // brand literals baked into the shared namespaces (`LobeHub`, `LobeChat`,
  // `Lobe AI`, …) would otherwise reach a white-label visitor verbatim. Register
  // the same post-processor the main app uses instead of relying on each call
  // site to interpolate `{{appName}}` — a consumer that forgets the value leaks
  // the raw placeholder, which is what INC-009 recorded. A no-op under default
  // branding, where the processor is never registered.
  let instance = i18next.createInstance();
  if (isBrandPostProcessorEnabled) instance = instance.use(brandPostProcessor);

  instance = instance.use(initReactI18next).use(resourcesToBackend(loadShareNamespace));

  return {
    init: (params: { initAsync?: boolean } = {}) =>
      instance.init({
        defaultNS: 'chat',
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
