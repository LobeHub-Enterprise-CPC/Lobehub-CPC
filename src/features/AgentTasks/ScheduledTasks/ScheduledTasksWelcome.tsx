import { Button, Icon } from '@lobehub/ui';
import {
  BadgePercent,
  FilePenLine,
  MailWarning,
  Newspaper,
  PencilLine,
  Presentation,
  UserRoundCheck,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ScheduleFrequency } from './scheduleForm';
import { styles } from './style';

export interface SchedulePreset {
  frequency?: ScheduleFrequency;
  instruction: string;
}

const templates = [
  { key: 'brief', icon: Newspaper },
  { key: 'customers', icon: UserRoundCheck },
  { key: 'weekly', icon: FilePenLine, frequency: 'weekly' },
  { key: 'mail', icon: MailWarning },
  { key: 'meetings', icon: Presentation },
  { key: 'sales', icon: BadgePercent, frequency: 'weekly' },
] as const;

export const ScheduledTasksWelcome = ({
  disabled,
  onCreate,
}: {
  disabled: boolean;
  onCreate: (preset?: SchedulePreset) => void;
}) => {
  const { t } = useTranslation('chat');
  return (
    <div className={styles.welcome} data-testid="scheduled-welcome">
      <div className={styles.welcomeContent}>
        <div className={styles.welcomeHero}>
          <div aria-hidden className={styles.clock}>
            <svg aria-hidden fill="none" height={40} viewBox="0 0 64 64" width={40}>
              <path
                d="M32 13V32L44 41"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={6}
              />
            </svg>
          </div>
          <h1 className={styles.welcomeTitle}>{t('scheduledTasks.welcome')}</h1>
          <Button
            className={styles.pill}
            disabled={disabled}
            icon={PencilLine}
            type="primary"
            onClick={() => onCreate()}
          >
            {t('scheduledTasks.newTask')}
          </Button>
        </div>
        <div className={styles.templates}>
          {templates.map((template) => (
            <Button
              className={styles.template}
              disabled={disabled}
              key={template.key}
              type="text"
              onClick={() =>
                onCreate({
                  instruction: t(`scheduledTasks.templates.${template.key}.instruction`),
                  frequency: 'frequency' in template ? template.frequency : 'daily',
                })
              }
            >
              <Icon icon={template.icon} size={24} />
              <div className={styles.templateText}>
                <span>{t(`scheduledTasks.templates.${template.key}.title`)}</span>
                <span className={styles.templateDescription}>
                  {t(`scheduledTasks.templates.${template.key}.description`)}
                </span>
              </div>
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
};
