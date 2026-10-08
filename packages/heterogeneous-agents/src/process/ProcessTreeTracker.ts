import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import debug from 'debug';

const log = debug('lobe:heterogeneous:process-tree');
export interface ProcessRow {
  identity: string;
  parent: number;
  pid: number;
}
let sampling: Promise<ProcessRow[]> | undefined;
function processTable() {
  sampling ??= promisify(execFile)('ps', ['-axo', 'pid=,ppid=,lstart='], {
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
  })
    .then(({ stdout }) =>
      stdout.split('\n').flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S.*)$/);
        return match
          ? [{ pid: Number(match[1]), parent: Number(match[2]), identity: match[3] }]
          : [];
      }),
    )
    .finally(() => {
      sampling = undefined;
    });
  return sampling;
}

/** A missing process observation is uncertainty, never permission to release a writer. */
export class ProcessTreeTracker {
  private readonly tracked = new Map<number, string>();
  private trackingFailed = false;
  private pending?: Promise<ProcessRow[]>;

  constructor(
    private readonly child: () => Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode'> | undefined,
    private readonly read = processTable,
    private readonly signal: (pid: number, signal: NodeJS.Signals) => unknown = process.kill,
  ) {}

  private sample() {
    if (this.pending) return this.pending;
    this.pending = this.read()
      .then((table) => {
        const child = this.child();
        const roots = new Set(
          table
            .filter(
              (row) =>
                this.tracked.get(row.pid) === row.identity ||
                (child?.pid === row.pid && child.exitCode === null && child.signalCode === null),
            )
            .map((row) => row.pid),
        );
        let changed = true;
        while (changed) {
          changed = false;
          for (const row of table) {
            if (!roots.has(row.pid) && !roots.has(row.parent)) continue;
            if (!roots.has(row.pid)) {
              roots.add(row.pid);
              changed = true;
            }
            this.tracked.set(row.pid, row.identity);
          }
        }
        return table;
      })
      .catch((error) => {
        this.trackingFailed = true;
        log(
          'Process observation failed; writer remains unconfirmed: %s',
          error instanceof Error ? error.name : 'unknown',
        );
        throw error;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  async track() {
    await this.sample().catch(() => {});
  }

  /** Observe natural exit without signalling deliberately retained background processes. */
  async isStopped() {
    try {
      const table = await this.sample();
      return (
        !this.trackingFailed && !table.some((row) => this.tracked.get(row.pid) === row.identity)
      );
    } catch {
      return false;
    }
  }

  async terminate(close: () => void, timeoutMs = 5000) {
    await this.track();
    close();
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      let table: ProcessRow[];
      try {
        table = await this.sample();
      } catch {
        return false;
      }
      const alive = table.filter((row) => this.tracked.get(row.pid) === row.identity);
      if (!alive.length) return !this.trackingFailed;
      for (const row of alive) {
        try {
          this.signal(row.pid, Date.now() - started > 1000 ? 'SIGKILL' : 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            log('Signal failed: pid=%d code=%s', row.pid, (error as NodeJS.ErrnoException).code);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }
}
