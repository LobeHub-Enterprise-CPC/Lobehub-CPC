import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { CHANNEL_LIMITS } from '@lobechat/types';

import type { CodexChannelSnapshot, CodexChannelStart } from './host';
import { CHANNEL_INSTRUCTIONS, channelInput } from './input';

export type DiscussionRuntime = 'amp' | 'grok-build';

/** Text discussion only. CLI tool catalogues are disabled; no approval bypass. */
export class ChannelDiscussionClient {
  private child?: ChildProcess;
  private readonly tracked = new Map<number, string>();
  private trackingFailed = false;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly runtime: DiscussionRuntime) {}

  static async probe(runtime: DiscussionRuntime) {
    const { stdout } = await promisify(execFile)(
      runtime === 'amp' ? 'amp' : 'grok',
      ['--version'],
      {
        timeout: 5000,
      },
    );
    return stdout.trim();
  }

  private async table() {
    const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,lstart='], {
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.split('\n').flatMap((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S.*)$/);
      return m ? [{ pid: Number(m[1]), parent: Number(m[2]), identity: m[3] }] : [];
    });
  }

  private async track() {
    try {
      const table = await this.table();
      const roots = new Set(
        table
          .filter(
            (r) =>
              this.tracked.get(r.pid) === r.identity ||
              (this.child?.pid === r.pid &&
                this.child.exitCode === null &&
                this.child.signalCode === null),
          )
          .map((r) => r.pid),
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
    } catch {
      this.trackingFailed = true;
    }
  }

  async closeAndConfirmTermination() {
    this.closed = true;
    clearInterval(this.timer);
    await this.track();
    const started = Date.now();
    while (Date.now() - started < 5000) {
      let table: Awaited<ReturnType<typeof this.table>>;
      try {
        table = await this.table();
      } catch {
        return false;
      }
      const alive = table.filter((r) => this.tracked.get(r.pid) === r.identity);
      if (!alive.length) return !this.trackingFailed;
      for (const row of alive) {
        try {
          process.kill(row.pid, Date.now() - started > 1000 ? 'SIGKILL' : 'SIGTERM');
        } catch {
          /* The next process table observation confirms termination. */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async run(
    input: CodexChannelStart,
    directory: string,
    snapshot: CodexChannelSnapshot,
    persist: () => Promise<void>,
  ) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const prompt = [
      ...(!input.sessionId && this.runtime === 'amp'
        ? [
            CHANNEL_INSTRUCTIONS,
            input.systemRole,
            'This is a text-only discussion. Do not call tools.',
          ]
        : []),
      channelInput(input.manifest),
    ]
      .filter(Boolean)
      .join('\n\n');
    const promptFile = path.join(directory, 'input.txt');
    await writeFile(promptFile, prompt, { mode: 0o600 });
    const args =
      this.runtime === 'amp'
        ? [
            ...(input.sessionId ? ['threads', 'continue', input.sessionId] : []),
            '--settings-file',
            path.join(directory, 'amp-settings.json'),
            '--no-ide',
            '--no-notifications',
            '--no-archive-after-execute',
            '--visibility',
            'private',
            '--stream-json',
            '-x',
            ...(input.model ? ['--mode', input.model] : []),
          ]
        : [
            '--tools',
            // Grok 1.0.30 treats an empty/unknown allowlist as the full catalogue.
            // A recognized allowlist followed by exclusion really yields no tools.
            'read_file',
            '--disallowed-tools',
            'read_file,search_tool,use_tool',
            '--deny',
            '*',
            '--system-prompt-override',
            [
              CHANNEL_INSTRUCTIONS,
              input.systemRole,
              'This is a text-only discussion. Do not call tools.',
            ]
              .filter(Boolean)
              .join('\n\n'),
            '--no-subagents',
            '--disable-web-search',
            '--max-turns',
            '1',
            '--output-format',
            'json',
            '--prompt-file',
            promptFile,
            ...(input.model ? ['--model', input.model] : []),
            ...(input.sessionId ? ['--resume', input.sessionId] : []),
          ];
    if (this.runtime === 'amp')
      await writeFile(
        path.join(directory, 'amp-settings.json'),
        JSON.stringify({
          'amp.tools.enable': ['__channel_no_tools__'],
          'amp.permissions': [{ tool: '*', action: 'reject' }],
          'amp.mcpServers': {},
          'amp.updates.mode': 'disabled',
        }),
        { mode: 0o600 },
      );
    snapshot.input = {
      prompt,
      systemRole:
        this.runtime === 'grok-build'
          ? args[args.indexOf('--system-prompt-override') + 1]
          : input.systemRole || '',
      runtime: this.runtime,
      resumedSessionId: input.sessionId || null,
    };
    await persist();
    if (this.closed) throw new Error('Run stopped before submission');
    const child = spawn(this.runtime === 'amp' ? 'amp' : 'grok', args, {
      cwd: input.cwd,
      env: process.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.once('spawn', () => {
      snapshot.status = 'running';
      snapshot.activity = 'running';
      void persist().catch(() => this.closeAndConfirmTermination());
    });
    let stdout = '',
      stderr = '';
    const result = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.stdin?.on('error', reject);
      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
        if (stdout.length > 8 * 1024 * 1024) {
          reject(new Error('CLI output limit exceeded'));
          void this.closeAndConfirmTermination();
        }
      });
      child.stderr?.on('data', (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-16000);
      });
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`${this.runtime} exited ${code}: ${stderr}`)),
      );
    });
    const timeout = setTimeout(() => {
      void this.closeAndConfirmTermination();
    }, CHANNEL_LIMITS.executionMs);
    this.timer = setInterval(() => {
      void this.track();
    }, 50);
    child.stdin?.end(this.runtime === 'amp' ? prompt : undefined);
    try {
      await result;
    } finally {
      clearTimeout(timeout);
      await writeFile(path.join(directory, 'output.json'), stdout, { mode: 0o600 });
    }
    if (this.closed) throw new Error('Discussion interrupted');
    const events =
      this.runtime === 'amp'
        ? stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [];
    const final =
      this.runtime === 'amp'
        ? events.findLast((event) => event.type === 'result')
        : JSON.parse(stdout);
    if (this.runtime === 'amp') {
      const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
      if (!init || init.tools?.length || !final || final.is_error || final.subtype !== 'success')
        throw new Error('Amp did not confirm a successful text-only turn');
    } else if (final.stopReason !== 'end_turn')
      throw new Error(`Grok stopped: ${final.stopReason}`);
    const content = this.runtime === 'amp' ? final.result : final.text;
    const sessionId = this.runtime === 'amp' ? final.session_id : final.sessionId;
    if (!content || !sessionId) throw new Error('CLI did not return content and session identity');
    snapshot.content = content;
    snapshot.sessionId = sessionId;
    snapshot.turnId = this.runtime === 'amp' ? input.runId : final.requestId;
    snapshot.modelCalls = final.num_turns;
    snapshot.toolCalls = 0;
    snapshot.acceptance = 'accepted';
  }
}
