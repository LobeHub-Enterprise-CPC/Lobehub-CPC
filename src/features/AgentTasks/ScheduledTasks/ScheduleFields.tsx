import { Flexbox, Input, InputNumber, Select, Switch, Text } from '@lobehub/ui';
import { useTranslation } from 'react-i18next';

import { WEEKDAYS } from '../AgentTaskDetail/scheduler/CronConfig';
import { FieldRow } from './FieldRow';
import type { ScheduleFormValue, ScheduleFrequency } from './scheduleForm';
import { styles } from './style';

export const ScheduleFields = ({
  onChange,
  value,
}: {
  onChange: (value: ScheduleFormValue) => void;
  value: ScheduleFormValue;
}) => {
  const { t } = useTranslation('chat');
  const update = (patch: Partial<ScheduleFormValue>) => onChange({ ...value, ...patch });
  const selectStyle = { minWidth: 120, maxWidth: '70%', width: 'auto', textAlign: 'end' as const };
  return (
    <Flexbox gap={8}>
      <Text fontSize={12} type="secondary">
        {t('scheduledTasks.frequency')}
      </Text>
      <FieldRow label={t('scheduledTasks.repeat')}>
        <Switch
          aria-label={t('scheduledTasks.repeat')}
          checked={value.frequency !== 'once'}
          onChange={(checked) => update({ frequency: checked ? 'daily' : 'once' })}
        />
      </FieldRow>
      {value.frequency !== 'once' && (
        <FieldRow id="schedule-frequency" label={t('scheduledTasks.frequency')}>
          <Select
            id="schedule-frequency"
            style={selectStyle}
            value={value.frequency}
            variant="borderless"
            suffixIcon={null}
            options={(
              ['daily', 'hourly', 'weekdays', 'weekly', 'monthly'] as ScheduleFrequency[]
            ).map((frequency) => ({
              label: t(`scheduledTasks.frequencies.${frequency}`),
              value: frequency,
            }))}
            onChange={(frequency) => update({ frequency })}
          />
        </FieldRow>
      )}
      {value.frequency === 'once' && (
        <FieldRow id="schedule-date" label={t('scheduledTasks.date')}>
          <input
            className={styles.nativeInput}
            id="schedule-date"
            type="date"
            value={value.date}
            onChange={(e) => update({ date: e.target.value })}
          />
        </FieldRow>
      )}
      {value.frequency === 'weekly' && (
        <FieldRow id="schedule-weekday" label={t('scheduledTasks.date')}>
          <Select
            id="schedule-weekday"
            options={[
              ...(typeof value.weekday === 'string' && value.weekday.includes(',')
                ? [
                    {
                      value: value.weekday,
                      label: value.weekday
                        .split(',')
                        .map((day) => t(`scheduledTasks.weekday.${day}`))
                        .join(' / '),
                    },
                  ]
                : []),
              ...WEEKDAYS.map(({ key }) => ({
                label: t(`scheduledTasks.weekday.${key}`),
                value: key,
              })),
            ]}
            style={selectStyle}
            value={value.weekday}
            variant="borderless"
            suffixIcon={null}
            onChange={(weekday) => update({ weekday })}
          />
        </FieldRow>
      )}
      {value.frequency === 'monthly' && (
        <FieldRow id="schedule-monthday" label={t('scheduledTasks.date')}>
          <Select
            id="schedule-monthday"
            style={selectStyle}
            value={value.monthDay}
            variant="borderless"
            suffixIcon={null}
            options={Array.from({ length: 31 }, (_, i) => ({
              label: t('scheduledTasks.monthDay', { day: i + 1 }),
              value: i + 1,
            }))}
            onChange={(monthDay) => update({ monthDay })}
          />
        </FieldRow>
      )}
      {value.frequency === 'hourly' ? (
        <FieldRow id="schedule-interval" label={t('scheduledTasks.every')}>
          <InputNumber
            id="schedule-interval"
            max={23}
            min={1}
            style={{ width: 120 }}
            suffix={t('taskSchedule.hours')}
            value={value.interval}
            onChange={(interval) => update({ interval: Number(interval) })}
          />
        </FieldRow>
      ) : (
        <FieldRow id="schedule-time" label={t('scheduledTasks.time')}>
          <Input
            id="schedule-time"
            inputMode="numeric"
            maxLength={5}
            placeholder="HH:mm"
            style={{ width: 100, textAlign: 'end' }}
            variant="borderless"
            value={value.time}
            onChange={(e) => update({ time: e.target.value })}
          />
        </FieldRow>
      )}
      {value.frequency === 'monthly' && value.monthDay > 28 && (
        <Text fontSize={12} type="secondary">
          {t('scheduledTasks.shortMonth')}
        </Text>
      )}
      {value.frequency !== 'once' && value.maxExecutions != null && value.maxExecutions > 0 && (
        <FieldRow id="schedule-max-executions" label={t('taskSchedule.maxExecutions')}>
          <InputNumber
            id="schedule-max-executions"
            min={1}
            precision={0}
            style={{ width: 100 }}
            value={value.maxExecutions}
            onChange={(maxExecutions) =>
              maxExecutions != null &&
              Number(maxExecutions) >= 1 &&
              update({ maxExecutions: Number(maxExecutions) })
            }
          />
        </FieldRow>
      )}
      {value.frequency !== 'once' && (
        <FieldRow label={t('scheduledTasks.endDate')}>
          <Switch
            aria-label={t('scheduledTasks.endDate')}
            checked={value.ends}
            onChange={(ends) => update({ ends })}
          />
        </FieldRow>
      )}
      {value.ends && value.frequency !== 'once' && (
        <FieldRow id="schedule-end" label={t('scheduledTasks.date')}>
          <input
            className={styles.nativeInput}
            id="schedule-end"
            type="date"
            value={value.endDate}
            onChange={(e) => update({ endDate: e.target.value })}
          />
        </FieldRow>
      )}
    </Flexbox>
  );
};
