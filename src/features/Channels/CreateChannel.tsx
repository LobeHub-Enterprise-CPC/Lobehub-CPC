import { Flexbox, Icon, Input } from '@lobehub/ui';
import { Button, createModal, Text, useModalContext } from '@lobehub/ui/base-ui';
import { type InputRef } from 'antd';
import { t } from 'i18next';
import { Hash } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { AgentMemberSelection } from '@/features/AgentMemberSelection';
import { useCreateMenuItems } from '@/features/HomeSidebar/hooks';
import { usePermission } from '@/hooks/usePermission';

import { EnvironmentFields } from './EnvironmentFields';
import { styles } from './styles';
import { type CreateChannelTarget, useCreateChannelForm } from './useCreateChannelForm';

/** Matches the `title` bound in `apps/server/src/routers/lambda/channel.ts`. */
const TITLE_MAX_LENGTH = 200;

type CreateChannelProps = Omit<CreateChannelTarget, 'onDone'>;

export function openCreateChannelModal(props: CreateChannelProps = {}) {
  return createModal({
    content: <CreateChannel {...props} />,
    footer: null,
    title: t(props.existing ? 'addMembers' : 'create', { ns: 'channel' }),
    width: 800,
  });
}

function CreateChannel({ onCreated, existing }: CreateChannelProps) {
  const { t } = useTranslation('channel');
  const { close, setCanDismissByClickOutside } = useModalContext();
  const { allowed: canCreateAgent } = usePermission('create_content');
  const { createAgent } = useCreateMenuItems();
  const titleInput = useRef<InputRef>(null);
  const form = useCreateChannelForm({ existing, onCreated, onDone: close });

  // A mask click must not drop what the user typed or picked; ✕ and Esc still close.
  useEffect(() => {
    setCanDismissByClickOutside(!form.dirty);
  }, [form.dirty, setCanDismissByClickOutside]);

  const submit = async () => {
    if ((await form.submit()) === 'title') titleInput.current?.focus();
  };
  const openCreateAgent = async () => {
    close();
    await createAgent();
  };
  const openConnectAgent = async () => {
    close();
    const { openConnectAgentModal } = await import('@/features/ConnectAgent');
    openConnectAgentModal();
  };
  const titleInvalid = form.invalid === 'title';

  return (
    <Flexbox gap={20}>
      {!existing && (
        <Flexbox gap={8}>
          <Text type="secondary">{t('description')}</Text>
          <Flexbox gap={6}>
            <label htmlFor="channel-title" style={{ fontWeight: 500 }}>
              {t('name')}
            </label>
            <Input
              autoFocus
              aria-describedby={titleInvalid ? 'channel-title-error' : undefined}
              aria-invalid={titleInvalid || undefined}
              disabled={form.busy}
              id="channel-title"
              maxLength={TITLE_MAX_LENGTH}
              placeholder={t('namePlaceholder')}
              prefix={<Icon icon={Hash} size={14} />}
              ref={titleInput}
              status={titleInvalid ? 'error' : undefined}
              value={form.title}
              onChange={(e) => form.changeTitle(e.target.value)}
              onPressEnter={() => void submit()}
            />
            {titleInvalid && (
              <Text fontSize={12} id="channel-title-error" type="danger">
                {t('nameRequired')}
              </Text>
            )}
          </Flexbox>
        </Flexbox>
      )}
      <Flexbox gap={8}>
        <Flexbox horizontal align="baseline" gap={12} justify="space-between">
          <Text weight={500}>{t('members')}</Text>
          <Text fontSize={12} type={form.memberHintDanger ? 'danger' : 'secondary'}>
            {form.memberHint}
          </Text>
        </Flexbox>
        <AgentMemberSelection
          agents={form.rows}
          disabled={form.busy}
          existingMembers={existing?.agentIds}
          isLoading={form.loadingAgents}
          maxCount={form.capacity}
          selectedAgentIds={form.selected}
          renderSelectedExtra={(agent) => {
            const environment = form.environmentOf(agent.id);
            if (!environment) return null;
            return (
              <EnvironmentFields
                agentId={agent.id}
                devices={form.devices}
                disabled={form.busy}
                hint={null}
                value={environment}
                onChange={(next) => form.changeEnvironment(agent.id, next)}
              />
            );
          }}
          onChange={form.changeSelection}
        />
        {form.needMoreAgents && (
          <Flexbox horizontal align="center" gap={8} wrap="wrap">
            <span className={styles.muted}>
              {form.eligibleCount
                ? t('needMoreAgents', { count: form.eligibleCount, min: form.minimum })
                : t('noAgents')}
            </span>
            {canCreateAgent && (
              <>
                <Button size="small" onClick={openCreateAgent}>
                  {t('createAgent')}
                </Button>
                <Button size="small" onClick={openConnectAgent}>
                  {t('connectAgent')}
                </Button>
              </>
            )}
          </Flexbox>
        )}
      </Flexbox>
      {(form.error || form.agentsError) && (
        <Flexbox gap={8} role="alert">
          <span className={styles.error}>{form.error?.message || t('refreshFailed')}</span>
          {form.error?.detail && <span className={styles.muted}>{form.error.detail}</span>}
          {form.agentsError && <Button onClick={() => form.reloadAgents()}>{t('reload')}</Button>}
        </Flexbox>
      )}
      <Flexbox horizontal gap={8} justify="flex-end">
        <Button disabled={form.busy} onClick={close}>
          {t('cancel')}
        </Button>
        <Button disabled={form.busy} loading={form.busy} type="primary" onClick={submit}>
          {t(existing ? 'addMembers' : 'submit')}
        </Button>
      </Flexbox>
    </Flexbox>
  );
}
