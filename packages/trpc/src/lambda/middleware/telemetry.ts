import { trpc } from '../init';
import { checkTelemetryEnabled, type TelemetryContext } from './checkTelemetryEnabled';

export {
  checkTelemetryEnabled,
  type TelemetryContext,
  type TelemetryResult,
} from './checkTelemetryEnabled';

/**
 * Middleware that checks if telemetry is enabled for the current user
 * and adds telemetryEnabled to the context
 *
 * Requires serverDatabase middleware to be applied first
 */
export const telemetry = trpc.middleware(async (opts) => {
  const result = await checkTelemetryEnabled(opts.ctx as TelemetryContext);

  return opts.next({ ctx: result });
});
