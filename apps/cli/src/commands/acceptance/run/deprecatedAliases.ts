import type { Command } from 'commander';

import { getTrpcClient } from '../../../api/client';
import { CLI_PRIMARY_BIN } from '../../../constants/identity';
import { log } from '../../../utils/logger';
import { installAction, type InstallOptions, withInstallOptions } from '../install';
import {
  evidenceDeleteAction,
  evidenceListAction,
  evidenceUploadAction,
  withEvidenceUploadOptions,
} from './evidence';
import { ingestReportAction, withIngestReportOptions } from './ingest';
import { reportGetAction, reportUpsertAction, withReportUpsertOptions } from './report';
import {
  decisionAction,
  resultIngestAction,
  resultListAction,
  submitAction,
  withResultIngestOptions,
  withResultListOptions,
  withSubmitOptions,
} from './result';
import {
  runCreateAction,
  runDeleteAction,
  runGetAction,
  runListAction,
  withRunCreateOptions,
  withRunDeleteOptions,
} from './session';

// ── Deprecated aliases: keep the old `${CLI_PRIMARY_BIN} verify …` spellings working ──

/** Warn once that a `lh verify` spelling has moved under `lh acceptance`. */
function deprecate(cmd: Command, replacement: string): Command {
  return cmd.hook('preAction', () => {
    log.warn(
      `\`${CLI_PRIMARY_BIN} verify ${cmd.name()}\` is deprecated — use \`${replacement}\` (removed in a future release)`,
    );
  });
}

/**
 * The pre-move `${CLI_PRIMARY_BIN} verify …` command surface, kept as thin aliases that wire the
 * exact same actions. Scheduled for removal once callers migrate to
 * `lh acceptance`. Layout mirrors the original flat shape so existing scripts and
 * tests keep working.
 */
export function attachDeprecatedVerifyRunAliases(verify: Command): void {
  // Both legacy spellings — `verify init` (server pull) and `verify install`
  // (the old bundled-skill installer) — converge on `acceptance install`.
  deprecate(
    withInstallOptions(
      verify.command('init').description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance install\``),
    ),
    `${CLI_PRIMARY_BIN} acceptance install`,
  ).action(async (options: InstallOptions) => installAction(options, await getTrpcClient()));

  deprecate(
    withInstallOptions(
      verify.command('install').description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance install\``),
    ),
    `${CLI_PRIMARY_BIN} acceptance install`,
  ).action(async (options: InstallOptions) => installAction(options, await getTrpcClient()));

  deprecate(
    withIngestReportOptions(
      verify
        .command('ingest-report <reportDir>')
        .description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run ingest\``),
    ),
    `${CLI_PRIMARY_BIN} acceptance run ingest`,
  ).action(ingestReportAction);

  const run = verify.command('run').description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run\``);
  deprecate(
    withRunCreateOptions(
      run.command('create').description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run create\``),
    ),
    `${CLI_PRIMARY_BIN} acceptance run create`,
  ).action(runCreateAction);
  run
    .command('list')
    .description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run list\``)
    .option('--json [fields]', 'Output JSON')
    .hook('preAction', () =>
      log.warn(`\`${CLI_PRIMARY_BIN} verify run list\` is deprecated — use \`${CLI_PRIMARY_BIN} acceptance run list\``),
    )
    .action(runListAction);
  run
    .command('get <runId>')
    .description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run get\``)
    .option('--json [fields]', 'Output JSON')
    .hook('preAction', () =>
      log.warn(`\`${CLI_PRIMARY_BIN} verify run get\` is deprecated — use \`${CLI_PRIMARY_BIN} acceptance run get\``),
    )
    .action(runGetAction);
  deprecate(
    withRunDeleteOptions(
      run.command('delete <runId>').description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run delete\``),
    ),
    `${CLI_PRIMARY_BIN} acceptance run delete`,
  ).action(runDeleteAction);

  const result = verify
    .command('result')
    .description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run result\``);
  deprecate(
    withResultIngestOptions(
      result.command('ingest').description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run result ingest\``),
    ),
    `${CLI_PRIMARY_BIN} acceptance run result ingest`,
  ).action(resultIngestAction);
  deprecate(
    withResultListOptions(
      result.command('list').description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run result list\``),
    ),
    `${CLI_PRIMARY_BIN} acceptance run result list`,
  ).action(resultListAction);

  deprecate(
    withSubmitOptions(
      verify.command('submit').description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run result submit\``),
    ),
    `${CLI_PRIMARY_BIN} acceptance run result submit`,
  ).action(submitAction);

  verify
    .command('decision <resultId> <decision>')
    .description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run result decision\``)
    .hook('preAction', () =>
      log.warn(`\`${CLI_PRIMARY_BIN} verify decision\` is deprecated — use \`${CLI_PRIMARY_BIN} acceptance run result decision\``),
    )
    .action(decisionAction);

  const evidence = verify
    .command('evidence')
    .description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run evidence\``);
  deprecate(
    withEvidenceUploadOptions(
      evidence
        .command('upload')
        .description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run evidence upload\``),
    ),
    `${CLI_PRIMARY_BIN} acceptance run evidence upload`,
  ).action(evidenceUploadAction);
  evidence
    .command('list <checkResultId>')
    .description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run evidence list\``)
    .option('--json [fields]', 'Output JSON')
    .hook('preAction', () =>
      log.warn(`\`${CLI_PRIMARY_BIN} verify evidence list\` is deprecated — use \`${CLI_PRIMARY_BIN} acceptance run evidence list\``),
    )
    .action(evidenceListAction);
  evidence
    .command('delete <evidenceId>')
    .description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run evidence delete\``)
    .option('--json [fields]', 'Output JSON')
    .hook('preAction', () =>
      log.warn(
        `\`${CLI_PRIMARY_BIN} verify evidence delete\` is deprecated — use \`${CLI_PRIMARY_BIN} acceptance run evidence delete\``,
      ),
    )
    .action(evidenceDeleteAction);

  const report = verify
    .command('report')
    .description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run report\``);
  deprecate(
    withReportUpsertOptions(
      report.command('upsert').description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run report upsert\``),
    ),
    `${CLI_PRIMARY_BIN} acceptance run report upsert`,
  ).action(reportUpsertAction);
  report
    .command('get <runId>')
    .description(`Deprecated — use \`${CLI_PRIMARY_BIN} acceptance run report get\``)
    .option('--json [fields]', 'Output JSON')
    .hook('preAction', () =>
      log.warn(`\`${CLI_PRIMARY_BIN} verify report get\` is deprecated — use \`${CLI_PRIMARY_BIN} acceptance run report get\``),
    )
    .action(reportGetAction);
}
