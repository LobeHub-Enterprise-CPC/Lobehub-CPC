/**
 * Static guard for work this server hands to itself later (spec FR-AS-05, FR-RT-05).
 *
 * QStash / Upstash Workflow callbacks and queue messages are delivered through the request proxy,
 * where a URL without the tenant prefix is refused with `TENANT_REQUIRED`. The prefix is decided in
 * one place, `modules/Tenant/callbackUrl.ts`; every producer must go through it:
 *
 * 1. no file may assemble a callback URL by hand (an internal path such as `/api/workflows/...`
 *    joined to an APP_URL-like base);
 * 2. a file that publishes (`publishJSON`, workflow `trigger`, `scheduleMessage`) must use the
 *    helper, unless it only forwards a URL its caller already built (REVIEWED_PUBLISHERS).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const SCAN_ROOTS = ['apps/server/src', 'src/app/(backend)'];

/** Where the tenant prefix is decided. */
const HELPER_FILE = 'apps/server/src/modules/Tenant/callbackUrl.ts';

/**
 * Publishers that forward a callback URL built by their caller: the queue implementations receive
 * `message.endpoint`, which `QueueService` callers build with `buildTenantCallbackUrl`.
 */
const REVIEWED_PUBLISHERS = new Set([
  'apps/server/src/services/queue/QueueService.ts',
  'apps/server/src/services/queue/impls/local.ts',
  'apps/server/src/services/queue/impls/qstash.ts',
]);

/**
 * The AgentRuntimeService modules schedule steps on `${deps.baseURL}/run`; `baseURL` is the
 * service's getter in `index.ts`, built with `buildTenantCallbackUrl` (and still scanned here).
 */
const AGENT_RUNTIME_SERVICE_DIR = 'apps/server/src/services/agentRuntime/AgentRuntimeService/';
const DELEGATED_BASE = /\$\{deps\.baseURL\}/;

const usesDelegatedBase = (file: string, code: string) =>
  file.startsWith(AGENT_RUNTIME_SERVICE_DIR) &&
  file !== `${AGENT_RUNTIME_SERVICE_DIR}index.ts` &&
  DELEGATED_BASE.test(code);

/**
 * Public webhooks registered with a bot platform: they are built on the tenant's public base
 * (`context.appUrl` = `tenantPublicBaseUrl()`), not on the server-to-server callback address.
 */
const REVIEWED_PUBLIC_WEBHOOKS = new Set([
  'apps/server/src/services/bot/platforms/telegram/client.ts',
]);

const HELPER = /\b(?:buildTenantCallbackUrl|tenantCallbackPath)\b/;
const PUBLISHER =
  /\.publishJSON\(|[wW]orkflowClient\.trigger\(|\bclient\.trigger\(|\.scheduleMessage\(/;
/** Paths served by this server that other servers/queues call back (not third-party API paths). */
const INTERNAL_PATH =
  /(?<=['"`}])\/(?:api\/(?:agent|workflows|webhooks|cron|internal)|trpc|webapi)(?:\/[^'"`]*)?['"`]/;
const BASE_URL = /APP_URL|getInternalApiUrl|AGENT_RUNTIME_BASE_URL|[bB]aseUrl|baseURL|BASE_URL/;
const JOINED = /urlJoin\(|new URL\(|\$\{|\+ ?['"]/;

const stripComments = (source: string) =>
  source
    .replaceAll(/\/\*[\S\s]*?\*\//g, (comment) => comment.replaceAll(/[^\n]/g, ' '))
    .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

export interface CallbackUrlViolation {
  file: string;
  kind: 'hand-assembled-url' | 'publisher-without-helper';
  line?: number;
}

export const scanCallbackProducers = (file: string, source: string): CallbackUrlViolation[] => {
  if (file === HELPER_FILE || REVIEWED_PUBLIC_WEBHOOKS.has(file)) return [];
  const code = stripComments(source);
  const violations: CallbackUrlViolation[] = [];
  if (
    PUBLISHER.test(code) &&
    !HELPER.test(code) &&
    !REVIEWED_PUBLISHERS.has(file) &&
    !usesDelegatedBase(file, code)
  )
    violations.push({ file, kind: 'publisher-without-helper' });
  const lines = code.split('\n');
  lines.forEach((line, index) => {
    if (!INTERNAL_PATH.test(line)) return;
    const window = lines.slice(Math.max(0, index - 3), index + 4).join('\n');
    if (BASE_URL.test(window) && JOINED.test(window) && !HELPER.test(window))
      violations.push({ file, kind: 'hand-assembled-url', line: index + 1 });
  });
  return violations;
};

const listSources = (directory: string): string[] =>
  readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .map((absolute) => path.relative(root, absolute).split(path.sep).join('/'))
    .filter(
      (file) =>
        !/(?:^|\/)(?:__tests__|__mocks__|tests)\/|\.(?:test|spec)\.tsx?$|\.d\.ts$/.test(file),
    );

describe('tenant callback URL producers', () => {
  it('flags the producers that were missed once', () => {
    // Shapes of the four producers that shipped without a tenant prefix.
    expect(
      scanCallbackProducers(
        'a.ts',
        "const url = `${process.env.APP_URL.replace(/\\/$/, '')}/api/workflows/widget/run-widget`;\nawait qstashClient.publishJSON({ url });",
      ).map((violation) => violation.kind),
    ).toEqual(['publisher-without-helper', 'hand-assembled-url']);
    expect(
      scanCallbackProducers('b.ts', "return urlJoin(baseUrl || 'http://x', '/api/agent');"),
    ).toEqual([{ file: 'b.ts', kind: 'hand-assembled-url', line: 1 }]);
    expect(
      scanCallbackProducers(
        'c.ts',
        "const baseUrl = appEnv.APP_URL;\nawait workflowClient.trigger({ url: new URL('/api/workflows/x/run', baseUrl).toString() });",
      ).map((violation) => violation.kind),
    ).toEqual(['publisher-without-helper', 'hand-assembled-url']);
    expect(
      scanCallbackProducers(
        'd.ts',
        "const baseURL = process.env.APP_URL;\nconst endpoint = new URL('/api/agent/webhooks/bot-replay', baseURL).toString();\nawait queue.scheduleMessage({ endpoint });",
      ).map((violation) => violation.kind),
    ).toEqual(['publisher-without-helper', 'hand-assembled-url']);
  });

  it('trusts the AgentRuntimeService base only inside its own modules', () => {
    const schedule =
      'await deps.queueService.scheduleMessage({ endpoint: `${deps.baseURL}/run` });';
    expect(scanCallbackProducers(`${AGENT_RUNTIME_SERVICE_DIR}asyncTool.ts`, schedule)).toEqual([]);
    expect(scanCallbackProducers(`${AGENT_RUNTIME_SERVICE_DIR}index.ts`, schedule)).toEqual([
      { file: `${AGENT_RUNTIME_SERVICE_DIR}index.ts`, kind: 'publisher-without-helper' },
    ]);
    expect(scanCallbackProducers('apps/server/src/services/other.ts', schedule)).toEqual([
      { file: 'apps/server/src/services/other.ts', kind: 'publisher-without-helper' },
    ]);
  });

  it('accepts producers that use the helper, third-party APIs and comments', () => {
    expect(
      scanCallbackProducers(
        'e.ts',
        "const url = buildTenantCallbackUrl('/api/workflows/x/run', baseUrl);\nawait client.trigger({ url });",
      ),
    ).toEqual([]);
    expect(scanCallbackProducers('f.ts', "new URL('/api/v1/agents', MARKET_BASE_URL)")).toEqual([]);
    expect(
      scanCallbackProducers('g.ts', "// urlJoin(APP_URL, '/api/agent') used to be here"),
    ).toEqual([]);
  });

  it('use buildTenantCallbackUrl in every file under apps/server and the backend routes', () => {
    const violations = SCAN_ROOTS.flatMap(listSources).flatMap((file) =>
      scanCallbackProducers(file, readFileSync(path.join(root, file), 'utf8')),
    );
    expect(violations).toEqual([]);
  });
});
