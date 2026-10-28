import { getTenant } from './client';
import { tenantRequestUrl } from './fetch';

/**
 * Tenant prefix for URLs the browser loads by itself.
 *
 * `installTenantFetch` covers what script requests, but an `<img src>`, a
 * `<video poster>` or an `<a href download>` is fetched by the browser from the
 * attribute as written. The server keeps some references origin-agnostic on
 * purpose (a user avatar is stored as `/webapi/user/avatar/{userId}/…`, so it
 * stays valid when the tenant's public address changes) and those would hit the
 * proxy without a tenant (`TENANT_REQUIRED`). Rewriting at the DOM boundary
 * covers every component, markdown image and already stored value the same way,
 * with the same rules as `fetch` (`tenantRequestUrl`): only same-origin paths of
 * a tenant backend surface change.
 *
 * Not covered: markup parsed from a string (`innerHTML`) and CSS `url()`; code
 * that puts a server path into CSS calls {@link resolveTenantAssetUrl}.
 */

/** Elements and the attributes on them that the browser loads or navigates to. */
const URL_ATTRIBUTES: Record<string, readonly string[]> = {
  a: ['href'],
  area: ['href'],
  audio: ['src'],
  embed: ['src'],
  iframe: ['src'],
  img: ['src'],
  source: ['src'],
  track: ['src'],
  video: ['poster', 'src'],
};

/** The same attributes as DOM properties, by interface (`img.src = …` skips `setAttribute`). */
const URL_PROPERTIES: ReadonlyArray<readonly [string, string]> = [
  ['HTMLAnchorElement', 'href'],
  ['HTMLAreaElement', 'href'],
  ['HTMLEmbedElement', 'src'],
  ['HTMLIFrameElement', 'src'],
  ['HTMLImageElement', 'src'],
  ['HTMLMediaElement', 'src'],
  ['HTMLSourceElement', 'src'],
  ['HTMLTrackElement', 'src'],
  ['HTMLVideoElement', 'poster'],
];

const INSTALLED = Symbol.for('lobechat.tenantAssets');

/** `value` as the browser should load it from a page of tenant `slug`. */
const assetUrl = (value: string, slug: string, win: Window): string =>
  tenantRequestUrl(value, slug, win.location) ?? value;

export const installTenantAssets = (win: Window & typeof globalThis = window): (() => void) => {
  const noop = () => {};
  const tenant = getTenant();
  if (!win.location?.pathname || !win.Element || !tenant?.slug || tenant.basePath === '')
    return noop;
  const slug = tenant.slug;

  const elementProto = win.Element.prototype as Element & { [INSTALLED]?: boolean };
  if (elementProto[INSTALLED]) return noop;

  const restores: Array<() => void> = [];

  const originalSetAttribute = elementProto.setAttribute;
  elementProto.setAttribute = function (this: Element, name: string, value: string) {
    const attributes = URL_ATTRIBUTES[this.localName];
    const next =
      attributes?.includes(name.toLowerCase()) && typeof value === 'string'
        ? assetUrl(value, slug, win)
        : value;
    return originalSetAttribute.call(this, name, next);
  };
  elementProto[INSTALLED] = true;
  restores.push(() => {
    elementProto.setAttribute = originalSetAttribute;
    delete elementProto[INSTALLED];
  });

  for (const [constructorName, property] of URL_PROPERTIES) {
    const proto = (win as unknown as Record<string, { prototype?: object } | undefined>)[
      constructorName
    ]?.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, property);
    if (!proto || !descriptor?.set || !descriptor.configurable) continue;

    const originalSet = descriptor.set;
    Object.defineProperty(proto, property, {
      ...descriptor,
      set(this: unknown, value: unknown) {
        originalSet.call(this, typeof value === 'string' ? assetUrl(value, slug, win) : value);
      },
    });
    restores.push(() => Object.defineProperty(proto, property, descriptor));
  }

  return () => {
    for (const restore of restores.reverse()) restore();
  };
};

/**
 * A server-returned app path in a form the browser can load from this page,
 * for the places the DOM boundary does not see (a CSS `background-image`).
 * Returns `value` unchanged when no tenant prefix applies.
 */
export const resolveTenantAssetUrl = (value: string): string => {
  const slug = getTenant()?.slug;
  if (!slug || getTenant()?.basePath === '' || typeof window === 'undefined') return value;
  return assetUrl(value, slug, window);
};
