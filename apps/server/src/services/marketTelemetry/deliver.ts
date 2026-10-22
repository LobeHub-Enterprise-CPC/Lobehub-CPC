import debug from 'debug';

import { type TelemetryReport } from '@/libs/market-telemetry';
import { after } from '@/server/utils/scheduleAfterResponse';

import {
  reportMarketTelemetry,
  type TelemetryDelivery,
  type TelemetryReportContext,
} from './reporter';

const log = debug('lobe-server:market-telemetry:deliver');

export interface DeliverTelemetryDeps {
  report?: (report: TelemetryReport, context: TelemetryReportContext) => Promise<TelemetryDelivery>;
  /** Defaults to running after the response, inside the request's tenant. */
  schedule?: (work: () => Promise<unknown>) => void;
}

/**
 * Hand a finished report to the reporter once the response is on its way.
 * Reporting is a side channel: nothing it does — a rejection, a scheduler that
 * is not there — reaches the code that produced the event.
 */
export const scheduleMarketTelemetry = (
  report: TelemetryReport,
  context: TelemetryReportContext,
  { report: deliver = reportMarketTelemetry, schedule = after }: DeliverTelemetryDeps = {},
): void => {
  try {
    schedule(async () => {
      try {
        await deliver(report, context);
      } catch (error) {
        log('Telemetry %s failed: %O', report.eventId, error);
      }
    });
  } catch (error) {
    log('Telemetry %s could not be scheduled: %O', report.eventId, error);
  }
};
