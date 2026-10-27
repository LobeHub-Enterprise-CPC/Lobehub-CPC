import { validateCronPattern } from '@lobechat/utils/cronEval';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

export type ScheduleFrequency = 'daily' | 'hourly' | 'monthly' | 'once' | 'weekdays' | 'weekly';

export interface ScheduleFormValue {
  date: string;
  endDate: string;
  ends: boolean;
  frequency: ScheduleFrequency;
  interval: number;
  monthDay: number;
  time: string;
  timezone: string;
  weekday: number;
}

export const initialSchedule = (
  pattern?: string | null,
  tz?: string | null,
  config?: Record<string, unknown>,
): ScheduleFormValue => {
  const [minute = '0', hour = '8', day = '*', , weekday = '*'] = (pattern || '0 8 * * *').split(
    ' ',
  );
  const schedule = config?.schedule as
    { endsAt?: string | null; onceAt?: string | null } | undefined;
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return {
    date: schedule?.onceAt
      ? dayjs(schedule.onceAt).tz(zone).format('YYYY-MM-DD')
      : dayjs().add(1, 'day').format('YYYY-MM-DD'),
    endDate: schedule?.endsAt ? dayjs(schedule.endsAt).tz(zone).format('YYYY-MM-DD') : '',
    ends: !!schedule?.endsAt,
    frequency: schedule?.onceAt
      ? 'once'
      : hour.includes('*')
        ? 'hourly'
        : day !== '*'
          ? 'monthly'
          : weekday === '1-5' || weekday === '1,2,3,4,5'
            ? 'weekdays'
            : weekday !== '*'
              ? 'weekly'
              : 'daily',
    interval: hour.startsWith('*/') ? Number(hour.slice(2)) : 1,
    monthDay: day !== '*' ? Number(day) : 1,
    time: `${hour.includes('*') ? '08' : hour.padStart(2, '0')}:${minute.padStart(2, '0')}`,
    timezone: zone,
    weekday: weekday !== '*' ? Number(weekday.split(',')[0]) || 0 : 1,
  };
};

/** Return an error key instead of letting invalid dates silently roll into another day. */
export const validateScheduleForm = (
  value: ScheduleFormValue,
  now = new Date(),
): 'invalidDate' | 'invalidEnd' | 'invalidInterval' | 'invalidTime' | null => {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return 'invalidTime';
  if (
    value.frequency === 'hourly' &&
    (!Number.isInteger(value.interval) || value.interval < 1 || value.interval > 23)
  )
    return 'invalidInterval';
  if (value.frequency === 'once') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return 'invalidDate';
    const date = dayjs.tz(`${value.date} ${value.time}`, value.timezone);
    if (!date.isValid() || date.format('YYYY-MM-DD') !== value.date || date.toDate() <= now)
      return 'invalidDate';
  }
  if (value.ends && value.frequency !== 'once') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.endDate)) return 'invalidEnd';
    const end = dayjs.tz(`${value.endDate} 23:59:59`, value.timezone);
    const upcoming = validateCronPattern(buildSchedule(value).schedulePattern, value.timezone, {
      count: 1,
      from: now,
    });
    if (upcoming.valid && upcoming.nextRuns[0] > end.toDate()) return 'invalidEnd';
    const start =
      value.frequency === 'once'
        ? dayjs.tz(`${value.date} ${value.time}`, value.timezone)
        : dayjs(now);
    if (!end.isValid() || end.format('YYYY-MM-DD') !== value.endDate || end.isBefore(start))
      return 'invalidEnd';
  }
  return null;
};

export const buildSchedule = (value: ScheduleFormValue) => {
  const [hour, minute] = value.time.split(':').map(Number);
  const date = dayjs.tz(`${value.date} ${value.time}`, value.timezone);
  const patterns: Record<ScheduleFrequency, string> = {
    daily: `${minute} ${hour} * * *`,
    hourly: `0 */${value.interval} * * *`,
    monthly: `${minute} ${hour} ${value.monthDay} * *`,
    once: `${minute} ${hour} ${date.date()} ${date.month() + 1} *`,
    weekdays: `${minute} ${hour} * * 1-5`,
    weekly: `${minute} ${hour} * * ${value.weekday}`,
  };
  return {
    schedulePattern: patterns[value.frequency],
    scheduleTimezone: value.timezone,
    schedule: {
      endsAt:
        value.frequency === 'once'
          ? date.add(25, 'minute').toISOString()
          : value.ends
            ? dayjs.tz(`${value.endDate} 23:59:59.999`, value.timezone).toISOString()
            : null,
      maxExecutions: value.frequency === 'once' ? 1 : null,
      onceAt: value.frequency === 'once' ? date.toISOString() : null,
    },
  };
};
