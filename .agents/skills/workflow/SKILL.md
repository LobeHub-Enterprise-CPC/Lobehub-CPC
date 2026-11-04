---
name: workflow
description: 'Use for durable workflow handlers, triggers, steps and async fan-out (`@/server/modules/Workflow`, delivered by Hatchet).'
user-invocable: false
---

# Workflow Implementation Guide

Standard patterns for durable async workflows in the LobeHub codebase. Workflows use
`serve` / `createWorkflow` / `serveMany` and `workflowClient` from `@/server/modules/Workflow`,
an Upstash-Workflow-compatible runtime: every delivery is a signed HTTP request sent by
Hatchet (queue mode) or by this process (local mode).

## Runtime semantics

- `context.run(name, fn)` results are memoized in Redis by **position and name**; a later
  delivery replays completed steps. Keep the order of steps deterministic and names stable
  across deploys — a renamed or reordered step runs again.
- A delivery that has worked for 5 minutes hands over to a fresh one at the next step
  boundary; `context.sleep` / `sleepUntil` and `context.invoke` likewise end the delivery and
  resume later. Never wrap steps in `try/catch` that swallows `WorkflowAbort`.
- One delivery executes a run at a time (per-run lock); `flowControl` takes per-key slots
  (`parallelism`) and a start rate (`rate`/`period`, or `ratePerSecond`).
- After the last retry (or a `WorkflowNonRetryableError`), `failureFunction` runs once and the
  run is marked failed. `workflowClient.cancel` stops runs by id or URL prefix.
- Local mode (`AGENT_RUNTIME_MODE` unset/`local`) keeps run state in memory and loses it on
  restart; queue mode needs Hatchet and Redis.

## 🎯 The Three Core Patterns

Every workflow in LobeHub combines these three patterns. They exist because the platform constrains you in three ways: rate limits make blind fan-out dangerous, step limits cap a single workflow's size, and idempotency demands that retries don't double-process.

1. **🔍 Dry-Run Mode** — get statistics without triggering actual execution
2. **🌟 Fan-Out Pattern** — split large batches into smaller chunks for parallel processing
3. **🎯 Single Task Execution** — each workflow execution processes **exactly ONE item**

---

## Architecture Overview

All workflows follow the same 3-layer architecture:

```text
Layer 1: Entry Point (process-*)
  ├─ Validates prerequisites
  ├─ Calculates total items to process
  ├─ Filters existing items
  ├─ Supports dry-run mode (statistics only)
  └─ Triggers Layer 2 if work is needed

Layer 2: Pagination (paginate-*)
  ├─ Handles cursor-based pagination
  ├─ Implements fan-out for large batches
  ├─ Recursively processes all pages
  └─ Triggers Layer 3 for each item

Layer 3: Single Task Execution (execute-* / generate-*)
  └─ Performs actual business logic for ONE item
```

**Real examples in this codebase:** `topicAutoSummary`, `agentEvalRun` — see [`references/examples.md`](./references/examples.md).

---

## The Three Patterns in 60 Seconds

### 1. Dry-Run Mode

Short-circuit Layer 1 before any side effects so callers can preview what would happen:

```typescript
if (dryRun) {
  return {
    ...result,
    dryRun: true,
    message: `[DryRun] Would process ${itemsNeedingProcessing.length} items`,
  };
}
```

Use case: check how many items will be processed before committing.

### 2. Fan-Out Pattern

Layer 2 splits oversized batches into chunks and recursively re-triggers itself with each chunk. This avoids hitting workflow step limits when one page contains too many items:

```typescript
const CHUNK_SIZE = 20;

if (itemIds.length > CHUNK_SIZE) {
  const chunks = chunk(itemIds, CHUNK_SIZE);
  await Promise.all(
    chunks.map((ids, idx) =>
      context.run(`workflow:fanout:${idx + 1}/${chunks.length}`, () =>
        WorkflowClass.triggerPaginateItems({ itemIds: ids }),
      ),
    ),
  );
}
```

Defaults: `PAGE_SIZE = 50` (items per page), `CHUNK_SIZE = 20` (items per fan-out chunk).

### 3. Single Task Execution

Layer 3 always processes exactly one item per invocation. Parallelism comes from Layer 2 fanning out to many Layer 3 invocations, controlled by `flowControl`:

```typescript
app.post(
  '/execute-item',
  serve<ExecutePayload>(
    async (context) => {
      const { itemId } = context.requestPayload ?? {};
      if (!itemId) return { success: false, error: 'Missing itemId' };

      const item = await context.run('workflow:get-item', () => getItem(itemId));
      const result = await context.run('workflow:execute', () => processItem(item));
      await context.run('workflow:save', () => saveResult(itemId, result));

      return { success: true, itemId, result };
    },
    {
      flowControl: { key: 'workflow.execute', parallelism: 10, ratePerSecond: 5 },
    },
  ),
);
```

---

## File Structure

```text
src/app/(backend)/api/workflows/
└── [[...route]]/route.ts             # Single catch-all — forwards every request to the Hono app below

apps/server/src/router-hono/workflows/
├── index.ts                          # Mounts each workflow's Hono app at /api/workflows/{workflow-name}
└── {workflow-name}/
    ├── index.ts                       # Hono app — one `app.post('/{layer}', serve(handler, options))` per layer
    ├── dispatch.ts / paginate-*.ts    # Layer 1 + 2 handler(s) — entry point, dry-run, pagination, fan-out
    └── execute.ts / execute-*.ts      # Layer 3 handler — single-task execution

apps/server/src/workflows/
└── {workflowName}/
    └── index.ts                       # Workflow class — static trigger*() methods that POST to the routes above
```

Every layer is a handler mounted on a per-workflow Hono app under `apps/server/src/router-hono/workflows/`; the Next.js route under `src/app` only dispatches into it.

---

## Where to Go Next

Pick the reference that matches what you're doing:

| You want to...                                     | Read                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Write the Workflow class + 3 routes from scratch   | [`references/implementation.md`](./references/implementation.md) |
| Tune flowControl, error handling, logging, testing | [`references/best-practices.md`](./references/best-practices.md) |
| See two real workflows end-to-end                  | [`references/examples.md`](./references/examples.md)             |

---

## Environment Variables

```bash
APP_URL=https://your-app.com          # Base URL; INTERNAL_APP_URL wins for server-to-server calls
AGENT_RUNTIME_MODE=queue              # queue = durable delivery through Hatchet; local = in-process
DELIVERY_SIGNING_KEY=<random secret>  # Signs deliveries; routes verify it (required in queue mode)
HATCHET_CLIENT_TOKEN=...              # Hatchet engine access (queue mode)
```

---

## Checklist for New Workflows

### Planning

- [ ] Identify the entity to process (users, agents, items, …)
- [ ] Define the per-item business logic
- [ ] Determine filtering logic (Redis cache, database state, …)

### Implementation

- [ ] Define payload types with TypeScript interfaces
- [ ] Create workflow class with static trigger methods
- [ ] **Layer 1:** entry point with **dry-run** support
- [ ] **Layer 1:** filtering logic to avoid duplicate work
- [ ] **Layer 2:** pagination with **fan-out**
- [ ] **Layer 3:** **single-task execution** (ONE item per run)
- [ ] Configure appropriate `flowControl` for each layer
- [ ] Consistent logging with workflow prefixes
- [ ] Validate all required payload parameters
- [ ] Unique `context.run()` step names

### Quality & Deployment

- [ ] Return consistent response shapes
- [ ] Write integration tests (`dryRun` path + full path)
- [ ] Smoke-test with dry-run first
- [ ] Test with a small batch before full rollout

---

## Additional Resources

- [Workflow runtime](../../../apps/server/src/modules/Workflow/)
- [Hatchet delivery runbook](../../../apps/server/src/modules/Hatchet/RUNBOOK.md)
- [Example Workflows in Codebase](<../../../src/app/(backend)/api/workflows/>)
- [Workflow Classes](../../../apps/server/src/workflows/)
