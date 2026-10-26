'use client';

import { Button, Empty } from '@lobehub/ui';
import * as stylex from '@stylexjs/stylex';
import { CloudOffIcon, LoaderCircleIcon, MonitorIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ExecutionTargetController } from '../useExecutionTargetController';

const styles = stylex.create({
  placeholder: {
    alignItems: 'center',
    display: 'flex',
    height: '100%',
    justifyContent: 'center',
    paddingInline: 8,
    width: '100%',
  },
  root: {
    paddingBlock: 12,
    paddingInline: 8,
  },
});

/**
 * Panel-styled empty states for the place picker's remote panel.
 * The legacy {@link ExecutionTargetDeviceList} menu keeps its own copy untouched.
 * Every case with nothing to list shares one placeholder. Loading and load
 * failure stay distinct so the panel is never blank.
 */
export const ExecutionPlaceRemoteEmpty = ({ model }: { model: ExecutionTargetController }) => {
  const { t } = useTranslation('chat');
  const descriptionProps = { fontSize: 12 } as const;

  if (model.poolStatus === 'loading') {
    return (
      <div {...stylex.props(styles.root)}>
        <Empty
          data-testid={'execution-place-remote-loading'}
          descriptionProps={descriptionProps}
          icon={LoaderCircleIcon}
          title={t('heteroAgent.executionTarget.loading')}
        />
      </div>
    );
  }

  if (model.poolStatus === 'error') {
    return (
      <div {...stylex.props(styles.root)}>
        <Empty
          data-testid={'execution-place-remote-load-failed'}
          descriptionProps={descriptionProps}
          icon={CloudOffIcon}
          title={t('heteroAgent.executionTarget.loadFailed')}
          action={
            <Button
              data-testid={'execution-place-remote-retry'}
              size={'small'}
              type={'primary'}
              onClick={() => void model.refreshDevices()}
            >
              {t('retry', { ns: 'common' })}
            </Button>
          }
        />
      </div>
    );
  }

  // Rows render beside this component. `devices` covers a confirmed pool even
  // when this render's row array is still empty.
  if (model.poolStatus === 'devices' || model.deviceRows.length > 0) return null;

  return (
    <div {...stylex.props(styles.placeholder)}>
      <Empty
        data-testid={'execution-place-remote-empty'}
        icon={MonitorIcon}
        title={t('heteroAgent.executionPlace.noRemoteDevicesTitle')}
      />
    </div>
  );
};
