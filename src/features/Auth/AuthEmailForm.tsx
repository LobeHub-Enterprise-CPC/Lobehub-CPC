'use client';

import { Icon } from '@lobehub/ui';
import { Button, Input } from '@lobehub/ui/base-ui';
import { Form, type FormInstance } from '@lobehub/ui/base-ui/form';
import { Mail } from 'lucide-react';
import { memo, type ReactNode, type Ref } from 'react';

import AuthAgreement from '@/features/AuthShell/AuthAgreement';

export interface AuthEmailFormProps {
  agreementChecked: boolean;
  /** Names the field for assistive technology when the placeholder is its only label. */
  ariaLabel?: string;
  autoComplete?: string;
  /** Rendered between the agreement and the submit button (inline failures). */
  beforeSubmit?: ReactNode;
  form: FormInstance<{ email: string }>;
  inputRef?: Ref<HTMLInputElement>;
  loading: boolean;
  onEmailChange?: () => void;
  placeholder: string;
  setAgreementChecked: (checked: boolean) => void;
  submitRef?: Ref<HTMLButtonElement | HTMLAnchorElement>;
  submitText: string;
  validate: (value: string) => string | undefined;
}

/**
 * The email step every auth card shares: one email field, the terms checkbox and the
 * primary button. The sign-in page and the organization lookup page both render it so the
 * hop between them keeps the same fields in the same places.
 */
export const AuthEmailForm = memo<AuthEmailFormProps>(
  ({
    agreementChecked,
    ariaLabel,
    autoComplete = 'username',
    beforeSubmit,
    form,
    inputRef,
    loading,
    onEmailChange,
    placeholder,
    setAgreementChecked,
    submitRef,
    submitText,
    validate,
  }) => (
    <Form form={form} gap={0} layout="vertical">
      <Form.Field
        name="email"
        style={{ gap: 0, paddingBlock: '0 24px' }}
        validate={validate}
        validateOn="submit"
      >
        <Input
          aria-label={ariaLabel}
          autoComplete={autoComplete}
          inputMode="email"
          placeholder={placeholder}
          prefix={<Icon icon={Mail} style={{ marginInline: 6 }} />}
          ref={inputRef}
          size="large"
          style={{ padding: 6 }}
          onChange={onEmailChange}
        />
      </Form.Field>
      <AuthAgreement checked={agreementChecked} onChange={setAgreementChecked} />
      {beforeSubmit}
      <Button block htmlType="submit" loading={loading} ref={submitRef} size="large" type="primary">
        {submitText}
      </Button>
    </Form>
  ),
);

AuthEmailForm.displayName = 'AuthEmailForm';

export default AuthEmailForm;
