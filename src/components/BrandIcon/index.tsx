import { type BrandIconKey, BRANDING_ICONS } from '@lobechat/business-const/icons';
import { cx } from '@lobehub/ui';
import type { LucideIcon, LucideProps } from 'lucide-react';
import type { Ref } from 'react';

const cache = new Map<BrandIconKey, LucideIcon>();

/**
 * The icon a deployment's brand puts at `key`, or `fallback` when it ships
 * none. The result accepts the same props as a lucide icon, so it drops into
 * `Icon`, `ActionIcon` and every other `icon` prop unchanged.
 *
 * Brand icons are drawn for their own box and stroke weight, so `strokeWidth`
 * and the fill props `Icon` passes down are ignored; `color` still applies,
 * through `currentColor`.
 */
export const brandIcon = (key: BrandIconKey, fallback: LucideIcon): LucideIcon => {
  const entry = BRANDING_ICONS[key];
  if (!entry) return fallback;

  const cached = cache.get(key);
  if (cached) return cached;

  const BrandIcon = (({
    ref,
    absoluteStrokeWidth: _absoluteStrokeWidth,
    children: _children,
    className,
    color,
    fill: _fill,
    fillOpacity: _fillOpacity,
    fillRule: _fillRule,
    size = 24,
    strokeWidth: _strokeWidth,
    style,
    ...rest
  }: LucideProps & { ref?: Ref<SVGSVGElement> }) => (
    <svg
      aria-hidden
      className={cx('lucide', className)}
      dangerouslySetInnerHTML={{ __html: entry.svg }}
      data-brand-icon={key}
      fill="none"
      height={size}
      ref={ref}
      style={color && color !== 'currentColor' ? { color, ...style } : style}
      viewBox={entry.viewBox}
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    />
  )) as unknown as LucideIcon;
  BrandIcon.displayName = `BrandIcon(${key})`;

  cache.set(key, BrandIcon);
  return BrandIcon;
};
