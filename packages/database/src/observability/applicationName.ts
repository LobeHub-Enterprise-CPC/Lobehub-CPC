import { hostname } from 'node:os';
import path from 'node:path';

import { CURRENT_VERSION } from '@lobechat/const';

/**
 * PostgreSQL `application_name` of every connection this server opens, so a
 * `pg_stat_activity` row says which service, pod, process and pool it belongs
 * to: `tw-<service>/<pod>/<pid>/<purpose>/<version>`, e.g.
 * `tw-executor/x2k9p/1/tenant/2.2.20`.
 *
 * PostgreSQL keeps at most 63 bytes and replaces non-ASCII characters, so
 * every segment is reduced to `[A-Za-z0-9._-]` and capped: the longest
 * possible name (3 + 16 + 1 + 5 + 1 + 7 + 1 + 19 + 1 + 8) is 62 bytes. It
 * names the process and the pool only, never a tenant, schema or user.
 */
export interface DbApplicationNameParts {
  hostname?: string;
  pid: number;
  purpose: string;
  service?: string;
  version?: string;
}

const MAX_LENGTH = 63;

const ascii = (value: string | undefined) => (value ?? '').replaceAll(/[^\w.-]/g, '');

const serviceSegment = (service: string | undefined) => ascii(service).slice(0, 16) || 'node';
/** The pod name's last 5 characters: the random suffix of a Deployment's pod. */
const podSegment = (host: string | undefined) => ascii(host).slice(-5) || '-';

export const buildDbApplicationName = (parts: DbApplicationNameParts): string =>
  [
    `tw-${serviceSegment(parts.service)}`,
    podSegment(parts.hostname),
    ascii(String(parts.pid)).slice(0, 7),
    ascii(parts.purpose).slice(0, 19) || '-',
    ascii(parts.version).slice(0, 8),
  ]
    .filter(Boolean)
    .join('/')
    .slice(0, MAX_LENGTH);

/**
 * The Deployment (or CronJob) a Kubernetes pod belongs to, from its name
 * `<owner>-<hash>-<suffix>`, without the `tituwork-` prefix; the web
 * Deployment `tituwork` is `web`. Undefined outside such a pod.
 */
const ownerOfPod = (pod: string) => {
  const owner = /^([a-z\d-]+?)-[a-z\d]{6,10}-[a-z\d]{5}$/.exec(pod)?.[1];
  if (!owner) return;
  return owner === 'tituwork' ? 'web' : owner.replace(/^tituwork-/, '');
};

/**
 * `DB_APP_SERVICE` when set; otherwise the pod's Deployment (`web`, `executor`,
 * `worker`, `memory-worker`, ...), so processes that run the same entry script
 * stay apart; otherwise the entry script (`server`, `migrate`, ...).
 */
const serviceName = () => {
  const configured = process.env.DB_APP_SERVICE;
  if (configured) return configured;
  const owner = ownerOfPod(hostname());
  if (owner) return owner;
  const entry = process.argv[1];
  return entry ? path.basename(entry).replace(/\.[^.]*$/, '') : undefined;
};

// os.hostname() is the pod name in Kubernetes. The HOSTNAME variable is not: the
// images set HOSTNAME=0.0.0.0 as the Next server's bind address.
const podName = () => hostname();

export const dbApplicationName = (purpose: string): string =>
  buildDbApplicationName({
    hostname: podName(),
    pid: process.pid,
    purpose,
    service: serviceName(),
    version: CURRENT_VERSION,
  });

/** The process fields of the name, for the `db.pool.stats` line. */
export const dbProcessIdentity = () => ({
  pid: process.pid,
  pod: podSegment(podName()),
  service: serviceSegment(serviceName()),
  version: CURRENT_VERSION,
});
