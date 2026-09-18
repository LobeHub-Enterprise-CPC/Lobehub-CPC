import { EditableText, Flexbox, Icon, Input } from '@lobehub/ui';
import { Button, createModal, Text, useModalContext } from '@lobehub/ui/base-ui';
import { type InputRef } from 'antd';
import { t } from 'i18next';
import { Hash } from 'lucide-react';
import { type RefObject, useEffect, useRef } from 'react';
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
type ChannelForm = ReturnType<typeof useCreateChannelForm>;

export function openCreateChannelModal(props: CreateChannelProps = {}) {
  return createModal({
    content: <CreateChannel {...props} />,
    footer: null,
    title: t(props.existing ? 'addMembers' : 'create', { ns: 'channel' }),
    width: 800,
  });
}

/**
 * Step one of creating a Channel. The name is the only thing on this screen, so the one
 * rule it carries is resolved before the user spends time placing Agents on devices.
 */
function NameStep({
  form,
  inputRef,
  onCancel,
  onNext,
}: {
  form: ChannelForm;
  inputRef: RefObject<InputRef | null>;
  onCancel: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation('channel');
  const invalid = form.invalid === 'title';

  return (
    <Flexbox gap={20}>
      <Flexbox gap={8}>
        <Text type="secondary">{t('description')}</Text>
        <Flexbox gap={6}>
          <label htmlFor="channel-title" style={{ fontWeight: 500 }}>
            {t('name')}
          </label>
          <Input
            autoFocus
            aria-describedby={invalid ? 'channel-title-error' : undefined}
            aria-invalid={invalid || undefined}
            id="channel-title"
            maxLength={TITLE_MAX_LENGTH}
            placeholder={t('namePlaceholder')}
            prefix={<Icon icon={Hash} size={14} />}
            ref={inputRef}
            status={invalid ? 'error' : undefined}
            value={form.title}
            onChange={(e) => form.changeTitle(e.target.value)}
            onPressEnter={onNext}
          />
          {invalid && (
            <Text fontSize={12} id="channel-title-error" type="danger">
              {t('nameRequired')}
            </Text>
          )}
        </Flexbox>
      </Flexbox>
      <Flexbox horizontal gap={8} justify="flex-end">
        <Button onClick={onCancel}>{t('cancel')}</Button>
        <Button type="primary" onClick={onNext}>
          {t('chooseMembers')}
        </Button>
      </Flexbox>
    </Flexbox>
  );
}

/**
 * Members, and where each one runs. Reached with a name already settled — a new Channel's
 * name goes back a step to change, an existing Channel's is renamed in place here.
 */
function MembersStep({
  existing,
  form,
  onBack,
  onSubmit,
}: {
  existing: CreateChannelProps['existing'];
  form: ChannelForm;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation(['channel', 'common']);
  const { close } = useModalContext();
  const { allowed: canCreateAgent } = usePermission('create_content');
  const { createAgent } = useCreateMenuItems();

  const openCreateAgent = async () => {
    close();
    await createAgent();
  };
  const openConnectAgent = async () => {
    close();
    const { openConnectAgentModal } = await import('@/features/ConnectAgent');
    openConnectAgentModal();
  };

  return (
    <Flexbox gap={20}>
      <Flexbox horizontal align="center" gap={6}>
        <Icon icon={Hash} size={16} />
        {existing ? (
          <EditableText
            inputProps={{ maxLength: TITLE_MAX_LENGTH }}
            showEditIcon={!form.busy}
            title={t('renameTitle')}
            value={form.title}
            onChangeEnd={form.rename}
          />
        ) : (
          <Text ellipsis weight={500}>
            {form.title}
          </Text>
        )}
      </Flexbox>
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
        <Button disabled={form.busy} onClick={existing ? close : onBack}>
          {existing ? t('cancel') : t('back', { ns: 'common' })}
        </Button>
        <Button disabled={form.busy} loading={form.submitting} type="primary" onClick={onSubmit}>
          {t(existing ? 'addMembers' : 'submit')}
        </Button>
      </Flexbox>
    </Flexbox>
  );
}

function CreateChannel({ onCreated, existing }: CreateChannelProps) {
  const { close, setCanDismissByClickOutside } = useModalContext();
  const titleInput = useRef<InputRef>(null);
  const form = useCreateChannelForm({ existing, onCreated, onDone: close });

  // A mask click must not drop what the user typed or picked; ✕ and Esc still close.
  useEffect(() => {
    setCanDismissByClickOutside(!form.dirty);
  }, [form.dirty, setCanDismissByClickOutside]);

  // The name step re-mounts its `autoFocus` input, so a rejected submit lands there too.
  const openMembers = () => {
    if (form.openMembers() === 'title') titleInput.current?.focus();
  };

  return form.step === 'name' ? (
    <NameStep form={form} inputRef={titleInput} onCancel={close} onNext={openMembers} />
  ) : (
    <MembersStep
      existing={existing}
      form={form}
      onBack={form.backToName}
      onSubmit={() => void form.submit()}
    />
  );
}
