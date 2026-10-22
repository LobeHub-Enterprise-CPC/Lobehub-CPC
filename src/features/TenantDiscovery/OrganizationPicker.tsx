'use client';

import { Flexbox, Icon } from '@lobehub/ui';
import { Alert, List, type ListItem, Modal, Text } from '@lobehub/ui/base-ui';
import { Loader2 } from 'lucide-react';
import { type KeyboardEvent, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { DiscoveredOrganization } from './api';

interface OrganizationPickerProps {
  /** Runs after the dialog has fully closed, to hand focus back to the page. */
  afterClose: () => void;
  errorText?: string;
  onClose: () => void;
  onSelect: (organization: DiscoveredOrganization) => void;
  open: boolean;
  organizations: DiscoveredOrganization[];
  selectingId: string | null;
  unavailableIds: ReadonlySet<string>;
}

const focusSibling = (event: KeyboardEvent<HTMLElement>) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
  ];
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
  rows[(next + rows.length) % rows.length]?.focus();
};

export const OrganizationPicker = memo<OrganizationPickerProps>(
  ({
    afterClose,
    errorText,
    onClose,
    onSelect,
    open,
    organizations,
    selectingId,
    unavailableIds,
  }) => {
    const { t } = useTranslation('auth');
    const busy = selectingId !== null;

    const items = useMemo<ListItem[]>(
      () =>
        organizations.map((organization) => {
          const unavailable = unavailableIds.has(organization.id);
          return {
            description: unavailable
              ? t('organization.picker.itemUnavailable')
              : organization.address,
            disabled: busy || unavailable,
            extra:
              selectingId === organization.id ? <Icon spin icon={Loader2} size={16} /> : undefined,
            key: organization.id,
            label: organization.name,
            onClick: () => onSelect(organization),
          };
        }),
      [busy, onSelect, organizations, selectingId, t, unavailableIds],
    );

    return (
      <Modal
        afterClose={afterClose}
        draggable={false}
        footer={null}
        keyboard={!busy}
        maskClosable={!busy}
        open={open}
        title={t('organization.picker.title')}
        width={440}
        onCancel={onClose}
      >
        <Flexbox gap={16}>
          <Text type={'secondary'}>{t('organization.picker.description')}</Text>
          {errorText && <Alert showIcon description={errorText} type={'error'} />}
          <div onKeyDown={focusSibling}>
            <List aria-busy={busy || undefined} items={items} variant={'outlined'} />
          </div>
        </Flexbox>
      </Modal>
    );
  },
);

OrganizationPicker.displayName = 'OrganizationPicker';
