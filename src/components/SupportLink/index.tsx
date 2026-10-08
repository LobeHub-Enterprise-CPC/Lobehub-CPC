import { BRANDING_EMAIL } from '@lobechat/business-const';
import type { ComponentProps } from 'react';

// Keep the displayed address and mail destination tied to the branding slot.
export default function SupportLink({ children, ...props }: Omit<ComponentProps<'a'>, 'href'>) {
  if (!BRANDING_EMAIL.support) return null;

  return (
    <a {...props} href={`mailto:${BRANDING_EMAIL.support}`}>
      {children ?? BRANDING_EMAIL.support}
    </a>
  );
}
