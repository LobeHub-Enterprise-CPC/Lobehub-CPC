import { type LobeChatDatabase } from '@lobechat/database';
import { currentTenantScope } from '@lobechat/database/tenant';
import debug from 'debug';

import { appEnv } from '@/envs/app';
import { type TelemetryReport } from '@/libs/market-telemetry';
import { checkTelemetryEnabled } from '@/libs/trpc/lambda/middleware/checkTelemetryEnabled';
import { generateTrustedClientToken, isTrustedClientEnabled } from '@/libs/trusted-client';
import { resolveTrustedClientIdentity } from '@/libs/trusted-client/resolveIdentity';

const log = debug('lobe-server:market-telemetry');

export interface TelemetryReportContext {
  /**
   * The user's Market token of a deployment without tenants (community,
   * single tenant). Never used for a tenant: a tenant reports as the trusted
   * client identity or not at all.
   */
  marketAccessToken?: string;
  serverDB?: LobeChatDatabase;
  /** Already decided by the caller (the tRPC `telemetry` middleware ran `checkTelemetryEnabled`). */
  telemetryEnabled?: boolean;
  userId?: string | null;
}

export type TelemetrySkipReason =
  'env-disabled' | 'identity' | 'no-credentials' | 'no-user' | 'user-disabled';

export type TelemetryDelivery =
  | { attempts: number; duplicate: boolean; status: 'delivered' }
  | {
      attempts: number;
      errorCode?: string;
      httpStatus?: number;
      reason: 'rejected' | 'unreachable';
      status: 'failed';
    }
  | { reason: TelemetrySkipReason; status: 'skipped' };

export interface TelemetryReporterDeps {
  fetch?: typeof fetch;
  /** Wait before try 2, 3, …; its length bounds the retries. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const DEFAULT_RETRY_DELAYS_MS = [250, 1000] as const;
const DEFAULT_TIMEOUT_MS = 8000;

const marketBaseUrl = () => process.env.MARKET_BASE_URL || 'https://market.lobehub.com';

const isRetryableStatus = (status: number) => status === 429 || status >= 500;

const readJson = async (response: Response): Promise<Record<string, any> | undefined> => {
  try {
    return (await response.json()) as Record<string, any>;
  } catch {
    return undefined;
  }
};

/**
 * Whether this user's own choice lets telemetry leave. A check that cannot be
 * answered is a no.
 */
const isTelemetryAllowed = async ({
  serverDB,
  telemetryEnabled,
  userId,
}: TelemetryReportContext): Promise<'user-disabled' | true> => {
  if (telemetryEnabled === false) return 'user-disabled';
  if (telemetryEnabled === true) return true;

  try {
    const result = await checkTelemetryEnabled({ serverDB, userId });
    return result.telemetryEnabled ? true : 'user-disabled';
  } catch (error) {
    log('Telemetry opt-out check failed, not reporting: %O', error);
    return 'user-disabled';
  }
};

type Authenticator = (() => Record<string, string>) | 'identity' | 'no-credentials';

/**
 * How this report authenticates. Decided once, and each send then asks for its
 * credentials afresh:
 *
 * - a tenant (a scope, or a deployment that signs trusted-client tokens) reports
 *   as the user's trust identity, `{ userId, email, name, tenantId }`. If that
 *   identity cannot be assembled there is no report — not a bearer token, not
 *   the default;
 * - without tenants the deployment's own user token is used, as before.
 */
const resolveAuthenticator = async (
  context: TelemetryReportContext,
): Promise<Authenticator | 'identity'> => {
  const multiTenant = Boolean(currentTenantScope()) || isTrustedClientEnabled();

  if (!multiTenant) {
    const { marketAccessToken } = context;
    return marketAccessToken
      ? () => ({ Authorization: `Bearer ${marketAccessToken}` })
      : 'no-credentials';
  }

  if (!isTrustedClientEnabled()) return 'identity';

  let identity;
  try {
    identity = await resolveTrustedClientIdentity({
      serverDB: context.serverDB,
      userId: context.userId!,
    });
  } catch (error) {
    // The code only: the error chain can carry a database error.
    log('Telemetry identity unavailable: %s', (error as Error).message);
    return 'identity';
  }
  if (!identity) return 'identity';

  // Issued per send, so a retry minutes later is not signed with a stale token.
  return () => {
    const token = generateTrustedClientToken(identity);
    if (!token) throw new Error('TRUST_TOKEN_UNAVAILABLE');
    return { 'x-lobe-trust-token': token };
  };
};

/**
 * Deliver one report to Market. Never throws: telemetry must not disturb the
 * execution it describes.
 *
 * What is sent is `report.body`, byte for byte, on every try — so Market can
 * tell a retry from a new event by `eventId` alone. A network failure, 429 or
 * 5xx is retried a few times; any other 4xx is Market's answer about this event
 * and is final. The credential is the one part that changes between tries.
 */
export const reportMarketTelemetry = async (
  report: TelemetryReport,
  context: TelemetryReportContext,
  {
    fetch: fetchImpl = fetch,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: TelemetryReporterDeps = {},
): Promise<TelemetryDelivery> => {
  try {
    // The environment decides before anything else is looked at.
    if (appEnv.TELEMETRY_DISABLED) return { reason: 'env-disabled', status: 'skipped' };
    if (!context.userId) return { reason: 'no-user', status: 'skipped' };

    const allowed = await isTelemetryAllowed(context);
    if (allowed !== true) return { reason: allowed, status: 'skipped' };

    const authenticator = await resolveAuthenticator(context);
    if (authenticator === 'identity' || authenticator === 'no-credentials') {
      return { reason: authenticator, status: 'skipped' };
    }

    const url = `${marketBaseUrl()}${report.path}`;
    const body = JSON.stringify(report.body);
    const maxAttempts = retryDelaysMs.length + 1;
    let lastFailure: Extract<TelemetryDelivery, { status: 'failed' }> | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let credentials: Record<string, string>;
      try {
        credentials = authenticator();
      } catch {
        return { reason: 'identity', status: 'skipped' };
      }

      try {
        const response = await fetchImpl(url, {
          body,
          headers: { 'Content-Type': 'application/json', ...credentials },
          method: 'POST',
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (response.ok) {
          const json = await readJson(response);
          return { attempts: attempt, duplicate: json?.duplicate === true, status: 'delivered' };
        }

        const json = await readJson(response);
        lastFailure = {
          attempts: attempt,
          errorCode: typeof json?.error?.code === 'string' ? json.error.code : undefined,
          httpStatus: response.status,
          reason: 'rejected',
          status: 'failed',
        };
        if (!isRetryableStatus(response.status)) return lastFailure;
      } catch {
        lastFailure = { attempts: attempt, reason: 'unreachable', status: 'failed' };
      }

      if (attempt < maxAttempts) await sleep(retryDelaysMs[attempt - 1]);
    }

    log('Telemetry %s not delivered: %O', report.eventId, lastFailure);
    return lastFailure!;
  } catch (error) {
    log('Telemetry %s failed unexpectedly: %O', report.eventId, error);
    return { attempts: 0, reason: 'unreachable', status: 'failed' };
  }
};
