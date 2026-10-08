import { Flexbox } from '@lobehub/ui';
import { Avatar, Button, Popover } from '@lobehub/ui/base-ui';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChannelDetail, MemberReceipt, ReceiptState } from './receipts';
import { isQuietReceipt } from './receipts';
import { statusStyles as styles } from './statusStyles';

export function receiptTone(state: ReceiptState | 'idle') {
  if (['awaiting_approval', 'offline', 'unavailable', 'paused', 'stop_requested'].includes(state))
    return 'attention';
  if (['failed', 'execution_unknown'].includes(state)) return 'error';
  if (['starting', 'running', 'typing', 'publishing'].includes(state)) return 'working';
  return 'quiet';
}

export function ReceiptStatus({ state }: { state: ReceiptState | 'idle' }) {
  const { t } = useTranslation('channel');
  return (
    <span className={styles.state} data-state={state} data-tone={receiptTone(state)}>
      {['replied', 'yielded', 'completed'].includes(state) ? (
        <Check size={12} />
      ) : (
        <span aria-hidden className={styles.dot} />
      )}
      {t(`receipt.state.${state}`)}
    </span>
  );
}

export function ReceiptDetail({ receipt }: { receipt: MemberReceipt }) {
  const { t } = useTranslation('channel');
  return (
    <Flexbox className={styles.popover} gap={12}>
      <Flexbox horizontal align="center" gap={8}>
        <Avatar
          avatar={receipt.member.config.avatar || '🤖'}
          size={28}
          title={receipt.member.name}
        />
        <strong>{receipt.member.name}</strong>
      </Flexbox>
      <ReceiptStatus state={receipt.state} />
      <span>{t(`receipt.hint.${receipt.state}`)}</span>
      {receipt.error && (
        <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{receipt.error}</span>
      )}
      <span className={styles.muted}>
        {t(receipt.accepted ? 'receipt.accepted' : 'receipt.saved')}
      </span>
      {receipt.hasReply && receipt.state !== 'replied' && (
        <span className={styles.muted}>{t('receipt.previousReply')}</span>
      )}
      {receipt.environment?.workingDirectory && (
        <Flexbox className={styles.environment} gap={4}>
          <span>{t('receipt.executionDirectory')}</span>
          <span>{receipt.environment.workingDirectory}</span>
        </Flexbox>
      )}
    </Flexbox>
  );
}

export function MessageReceipts({
  receipts,
  routingStatus,
}: {
  receipts: MemberReceipt[];
  routingStatus: ChannelDetail['messages'][number]['routingStatus'];
}) {
  const { t } = useTranslation('channel');
  const [expanded, setExpanded] = useState(false);
  const quiet = receipts.length > 0 && receipts.every(isQuietReceipt);
  if (!receipts.length)
    return routingStatus === 'unassigned' || routingStatus === 'pending' ? (
      <span className={`${styles.receipts} ${styles.muted}`}>
        {t(routingStatus === 'unassigned' ? 'receipt.unassigned' : 'receipt.assigning')}
      </span>
    ) : null;
  return (
    <Flexbox data-message-receipts align="flex-start" className={styles.receipts} gap={4}>
      {quiet && (
        <Button
          aria-expanded={expanded}
          aria-label={t('receipt.expand', { count: receipts.length })}
          icon={expanded ? ChevronUp : ChevronDown}
          size="small"
          type="text"
          onClick={() => setExpanded((value) => !value)}
        >
          <Flexbox horizontal align="center" gap={4}>
            {receipts.map(({ member }) => (
              <Avatar
                avatar={member.config.avatar || '🤖'}
                key={member.id}
                size={16}
                title={member.name}
              />
            ))}
            <span className={styles.muted}>{t('receipt.settled', { count: receipts.length })}</span>
          </Flexbox>
        </Button>
      )}
      {(!quiet || expanded) && (
        <Flexbox horizontal align="center" gap={4} justify="flex-start" wrap="wrap">
          {receipts.map((receipt) => (
            <Popover
              content={<ReceiptDetail receipt={receipt} />}
              key={receipt.member.id}
              placement="bottomLeft"
              trigger="click"
            >
              <Button
                className={styles.chip}
                data-member-receipt={receipt.member.id}
                data-state={receipt.state}
                size="small"
                type="text"
                aria-label={t('receipt.memberLabel', {
                  name: receipt.member.name,
                  state: t(`receipt.state.${receipt.state}`),
                })}
              >
                <Avatar
                  avatar={receipt.member.config.avatar || '🤖'}
                  size={18}
                  title={receipt.member.name}
                />
                <span className={styles.name}>{receipt.member.name}</span>
                <ReceiptStatus state={receipt.state} />
              </Button>
            </Popover>
          ))}
        </Flexbox>
      )}
    </Flexbox>
  );
}
