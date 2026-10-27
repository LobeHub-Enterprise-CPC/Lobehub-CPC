import { Flexbox, InputNumber, Select, Switch, Text } from '@lobehub/ui';
import { useTranslation } from 'react-i18next';

import { TIMEZONE_OPTIONS, WEEKDAYS } from '../AgentTaskDetail/scheduler/CronConfig';
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
  const selectStyle = { minWidth: 120, maxWidth: '70%' };
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
            options={WEEKDAYS.map(({ key, label }) => ({ label: t(label), value: key }))}
            style={selectStyle}
            value={value.weekday}
            variant="borderless"
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
          <input
            className={styles.nativeInput}
            id="schedule-time"
            type="time"
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
      <FieldRow id="schedule-timezone" label={t('taskSchedule.timezone')}>
        <Select
          showSearch
          id="schedule-timezone"
          style={{ maxWidth: '70%', width: 220 }}
          value={value.timezone}
          variant="borderless"
          options={
            TIMEZONE_OPTIONS.some((tz) => tz.value === value.timezone)
              ? TIMEZONE_OPTIONS
              : [{ label: value.timezone, value: value.timezone }, ...TIMEZONE_OPTIONS]
          }
          onChange={(timezone) => update({ timezone })}
        />
      </FieldRow>
    </Flexbox>
  );
};
