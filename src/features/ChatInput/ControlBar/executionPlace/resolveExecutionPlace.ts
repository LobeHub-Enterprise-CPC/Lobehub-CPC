import type { DeviceExecutionTarget } from '@lobechat/types';

/** The three places the enterprise picker shows. `none` and `auto` read as cloud. */
export type ExecutionPlace = 'cloud' | 'local' | 'remote';

export interface ResolveExecutionPlaceParams {
  /**
   * A fenced local run is still "this computer". The flag is part of the input
   * so a caller cannot treat the sandbox modifier as its own place.
   */
  localSandboxEnabled?: boolean;
  target: DeviceExecutionTarget | undefined;
}

/**
 * Map a stored execution target onto the three-place trigger.
 * Local sandbox stays local. `none` and `auto` stay stored and read as cloud.
 */
export const resolveExecutionPlace = ({ target }: ResolveExecutionPlaceParams): ExecutionPlace => {
  if (target === 'local') return 'local';
  if (target === 'device') return 'remote';
  return 'cloud';
};
