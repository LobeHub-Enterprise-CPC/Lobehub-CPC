# recoverVideoGenerationTasks

Recovery helper for video generation tasks whose result never reached the database
during the Volcengine/Seedance webhook-only regression: the task was submitted, the
upstream render succeeded, but nothing was ever polled, so the user got
`task is timeout, please try again` while Ark held a finished video.

It never edits `async_tasks.status` on its own. A task only becomes `Success` by
replaying the production completion chain (`processBackgroundVideoPolling`), which
downloads the video, stores asset + file, writes the status and runs the same
completion charge as the live poller.

## Usage

Dry run first — it writes nothing:

```bash
tsx scripts/recoverVideoGenerationTasks/index.ts
tsx scripts/recoverVideoGenerationTasks/index.ts --limit 50
tsx scripts/recoverVideoGenerationTasks/index.ts --async-task-id <uuid>
```

Then, after reviewing the classification:

```bash
tsx scripts/recoverVideoGenerationTasks/index.ts --apply --confirm-recovery
```

`--apply` without `--confirm-recovery` is rejected on purpose. The script needs the
normal server environment (`DATABASE_URL`, provider credentials, storage) because it
imports the server modules.

## Classification

| Verdict | Meaning |
| --- | --- |
| `recoverable` | Upstream returned a `video_url`, nothing is stored locally — the only verdict `--apply` acts on |
| `recovered` | The chain ran and the task is now `Success` with an asset |
| `upstream-pending` | Still queued/running upstream; re-run later |
| `upstream-failed` | Upstream reported a terminal failure |
| `upstream-expired` | Upstream reported the result expired |
| `upstream-unreachable` | The status query itself failed (credentials, route gone, network); re-run later |
| `already-stored` | The generation already has an asset — skipped, never overwritten |
| `needs-manual-review` | No linked generation, no provider/model, a non-timeout terminal error, or a completion that was already claimed (a previous completion may have charged) |

## Safety and idempotency

- Read-only unless `--apply --confirm-recovery`.
- A task is skipped when its generation already carries an asset, so a second run
  cannot store a duplicate.
- A task whose metadata already holds `completionClaimedAt` is never replayed: a
  completion already ran once and whether it charged is not knowable from here.
- The status is re-opened (`Error` → `Processing`) only immediately before the chain
  runs, and only for tasks whose upstream result is already available;
  `AsyncTaskModel.claimVideoCompletion` still guarantees a single completion, and the
  completion charge reuses the stored `precharge` record.
- The dry-run output lists `precharge` / `spendOrigin` presence per task so the
  billing state can be reviewed before applying anything.
