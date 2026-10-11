import { Flexbox } from '@lobehub/ui';
import { Button, Input, InputPassword, Text, toast } from '@lobehub/ui/base-ui';
import { Form, useForm } from '@lobehub/ui/base-ui/form';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import AuthCard from '@/features/AuthCard';
import { sanitizeRedirectPath } from '@/utils/onboardingRedirect';

const schema = z.object({ email: z.email(), password: z.string().min(1) });
export default function BridgeAccountLink({
  task,
  onCancel,
}: {
  task: { taskId: string; csrfToken: string };
  onCancel: () => void;
}) {
  const { t } = useTranslation('auth');
  const [accountLabel, setAccountLabel] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const request = async (path: string, values?: { email: string; password: string }) => {
    const response = await fetch(`/api/auth/bridge/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify({ ...task, ...values }),
    });
    if (!response.ok) throw new Error('BRIDGE_LINK_FAILED');
    return response.json();
  };
  const run = async (operation: () => Promise<void>, error: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await operation();
    } catch {
      toast.error(error);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const form = useForm<{ email: string; password: string }>({
    schema,
    initialValues: { email: '', password: '' },
    onSubmit: (values) =>
      run(async () => {
        const result = await request('link/verify', values);
        setAccountLabel(result.accountLabel);
        form.reset({ ...values, password: '' });
      }, t('bridge.verifyFailed')),
  });
  return (
    <AuthCard subtitle={t('bridge.linkDescription')} title={t('bridge.linkTitle')}>
      {accountLabel ? (
        <Flexbox gap={16}>
          <Text>{t('bridge.confirmAccount', { email: accountLabel })}</Text>
          <Button
            block
            loading={busy}
            type="primary"
            onClick={() =>
              run(async () => {
                const result = await request('link/confirm');
                window.location.assign(sanitizeRedirectPath(result.callbackURL || '/'));
              }, t('bridge.confirmFailed'))
            }
          >
            {t('bridge.confirm')}
          </Button>
        </Flexbox>
      ) : (
        <Form form={form} layout="vertical">
          <Form.Field label={t('bridge.email')} name="email">
            <Input autoComplete="username" disabled={busy} placeholder="name@example.com" />
          </Form.Field>
          <Form.Field label={t('bridge.password')} name="password">
            <InputPassword
              autoComplete="current-password"
              disabled={busy}
              placeholder={t('betterAuth.signin.passwordPlaceholder')}
            />
          </Form.Field>
          <Button block htmlType="submit" loading={busy} type="primary">
            {t('bridge.verify')}
          </Button>
        </Form>
      )}
      <Button
        disabled={busy}
        onClick={() =>
          run(async () => {
            try {
              await request('cancel');
            } finally {
              onCancel();
            }
          }, t('bridge.failed'))
        }
      >
        {t('bridge.cancel')}
      </Button>
    </AuthCard>
  );
}
