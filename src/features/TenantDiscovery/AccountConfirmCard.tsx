'use client';

import {
  Alert,
  Avatar,
  Button,
  createStaticStyles,
  Flexbox,
  Icon,
  List,
  type ListItem,
  SkeletonAvatar,
  SkeletonText,
  Text,
} from '@lobehub/ui';
import { ChevronRight, Loader2 } from 'lucide-react';
import { type KeyboardEvent, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { type DiscoveredOrganization } from './api';
import { type useRememberedAccount } from './useRememberedAccount';

const styles = createStaticStyles(({ css, cssVar }) => ({
  accountRow: css`
    display: flex;
    gap: 12px;
    align-items: center;

    padding-block: 12px;
    padding-inline: 16px;
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorFillQuaternary};
  `,
  email: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  lastUsed: css`
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 12px;
    padding-inline: 16px;
    border: 1px solid ${cssVar.colorPrimaryBorder};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorPrimaryBg};
  `,
  lastUsedText: css`
    overflow: hidden;
    flex: 1;
  `,
  sectionLabel: css`
    font-size: 13px;
  `,
  selectableRow: css`
    && {
      color: ${cssVar.colorText};
    }

    &&:not([aria-disabled='true']):hover,
    &&:not([aria-disabled='true']):focus-visible {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  skeleton: css`
    display: flex;
    flex-direction: column;
    gap: 16px;
  `,
  skeletonRow: css`
    display: flex;
    gap: 12px;
    align-items: center;
  `,
  useAnother: css`
    text-align: center;
  `,
}));

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

type AccountState = ReturnType<typeof useRememberedAccount>;

const emailInitial = (email: string): string => {
  const initial = email.trim().charAt(0);
  return initial ? initial.toUpperCase() : '?';
};

interface AccountListProps {
  locked: boolean;
  onChoose: (organization: DiscoveredOrganization) => void;
  organizations: DiscoveredOrganization[];
  selectingId: string | null;
  unavailableIds: ReadonlySet<string>;
}

const AccountList = memo<AccountListProps>(
  ({ locked, onChoose, organizations, selectingId, unavailableIds }) => {
    const { t } = useTranslation('auth');
    const items = useMemo<ListItem[]>(
      () =>
        organizations.map((organization) => {
          const unavailable = unavailableIds.has(organization.id);
          return {
            className: unavailable ? undefined : styles.selectableRow,
            description: unavailable
              ? t('organization.picker.itemUnavailable')
              : organization.address,
            disabled: locked || unavailable,
            extra:
              selectingId === organization.id ? (
                <Icon spin icon={Loader2} size={16} />
              ) : unavailable ? undefined : (
                <Icon icon={ChevronRight} size={16} />
              ),
            key: organization.id,
            label: organization.name,
            onClick: () => onChoose(organization),
          };
        }),
      [locked, onChoose, organizations, selectingId, t, unavailableIds],
    );

    return (
      <div onKeyDown={focusSibling}>
        <List aria-busy={selectingId !== null || undefined} items={items} variant={'outlined'} />
      </div>
    );
  },
);

AccountList.displayName = 'AccountList';

/**
 * The remembered-account confirm card: the account row, the highlighted last-used
 * organization with the primary continue action, the remaining organizations as selectable
 * rows, and the "use another account" escape hatch. It lives in the same `AuthCard` as the
 * finder form, so switching between them never moves the card on the page.
 */
export const AccountConfirmCard = memo<{ state: AccountState }>(({ state }) => {
  const { t } = useTranslation('auth');
  const {
    account,
    choose,
    lastUsed,
    locked,
    notice,
    others,
    retry,
    retryIn,
    selectingId,
    unavailableIds,
    useAnotherAccount,
  } = state;

  // The hook stores only the failure's meaning; the countdown seconds come from `retryIn`.
  const noticeText = !notice
    ? null
    : notice.kind === 'rateLimited'
      ? retryIn !== null && retryIn > 0
        ? t('organization.discovery.rateLimited', { seconds: retryIn })
        : t('organization.discovery.rateLimitedGeneric')
      : notice.kind === 'notAvailable'
        ? t('organization.discovery.notAvailable')
        : t('organization.discovery.unavailable');

  if (!account) {
    if (noticeText)
      return (
        <Flexbox gap={16}>
          <Alert showIcon description={noticeText} type={'error'} />
          <Button block disabled={locked} onClick={retry}>
            {t('organization.account.retry')}
          </Button>
        </Flexbox>
      );
    return (
      <div
        aria-busy
        aria-label={t('organization.account.loading')}
        className={styles.skeleton}
        role={'status'}
      >
        <Text type={'secondary'}>{t('organization.account.loading')}</Text>
        <div className={styles.skeletonRow}>
          <SkeletonAvatar size={40} />
          <SkeletonText style={{ flex: 1 }} />
        </div>
        <SkeletonText rows={3} />
      </div>
    );
  }

  return (
    <Flexbox gap={16}>
      {noticeText && <Alert showIcon description={noticeText} type={'error'} />}
      <div className={styles.accountRow} title={account.email}>
        <Avatar aria-hidden avatar={emailInitial(account.email)} shape={'circle'} size={40} />
        <Text ellipsis className={styles.email}>
          {account.email}
        </Text>
      </div>
      {lastUsed && (
        <Flexbox gap={8}>
          <Text className={styles.sectionLabel} type={'secondary'}>
            {t('organization.account.lastUsed')}
          </Text>
          <div className={styles.lastUsed}>
            <div className={styles.lastUsedText} title={lastUsed.address ?? lastUsed.name}>
              <Text ellipsis weight={500}>
                {lastUsed.name}
              </Text>
              {lastUsed.address && (
                <Text ellipsis fontSize={13} type={'secondary'}>
                  {lastUsed.address}
                </Text>
              )}
            </div>
            <Button
              disabled={locked}
              loading={selectingId === lastUsed.id}
              type={'primary'}
              onClick={() => choose(lastUsed)}
            >
              {t('organization.account.continue')}
            </Button>
          </div>
        </Flexbox>
      )}
      {others.length > 0 && (
        <Flexbox gap={8}>
          <Text className={styles.sectionLabel} type={'secondary'}>
            {t('organization.account.others')}
          </Text>
          <AccountList
            locked={locked}
            organizations={others}
            selectingId={selectingId}
            unavailableIds={unavailableIds}
            onChoose={choose}
          />
        </Flexbox>
      )}
      {noticeText && (
        <Button block disabled={locked} onClick={retry}>
          {t('organization.account.retry')}
        </Button>
      )}
      <div className={styles.useAnother}>
        <Button disabled={locked} type={'link'} onClick={useAnotherAccount}>
          {t('organization.account.useAnother')}
        </Button>
      </div>
    </Flexbox>
  );
});

AccountConfirmCard.displayName = 'AccountConfirmCard';
