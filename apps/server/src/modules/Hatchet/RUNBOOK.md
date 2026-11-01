# Hatchet delivery: cutover and rollback runbook

Queue-mode agent steps (`cpc-agent-step`) and one-off deliveries (`cpc-delivery`) run on a self-hosted Hatchet engine when `AGENT_RUNTIME_MODE=queue` and `AGENT_RUNTIME_DELIVERY=hatchet`. This runbook covers turning that on, turning it off again, and rolling the image back to a build without Hatchet delivery.

Commands that query a tenant run in that tenant's schema (`SET search_path` to the tenant schema, or schema-qualify the table) and are repeated for every tenant.

## Deployment checklist

Confirm and record each item before enabling Hatchet delivery.

1. **Mode and client.** `AGENT_RUNTIME_MODE=queue`, `AGENT_RUNTIME_DELIVERY=hatchet`, and every `HATCHET_CLIENT_*` setting the SDK needs. The token's `sub` names the target Hatchet tenant.
2. **Message size.** `HATCHET_CLIENT_GRPC_MAX_SEND_MESSAGE_LENGTH` and `HATCHET_CLIENT_GRPC_MAX_RECV_MESSAGE_LENGTH` are both at least 16 MiB (`16777216`), and the engine's gRPC maximum message size is raised to match. The SDK default is 4 MiB. An agent step whose input does not fit the smaller of the two limits (minus 64 KiB) has its oversized strings clamped before publishing (`agent.queue.oversized_message_clamped`), so a low limit loses context rather than failing the step.
3. **Signing keys.** `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` are both set. Our own routes verify every delivery with them; with either one missing, every delivery answers 401. Only deliveries to our own origin are signed. External webhooks are delivered unsigned, because the receiving routes do not bind the signature to the URL.
4. **Reconciliation cron.** A scheduler calls `POST /api/cron/agent/reap-operations` with `Authorization: Bearer $CRON_SECRET`. Record the interval. This is the only entry point for the stale-operation reaper and the two reconcilers (async-tool resume, sub-agent bridge). The cron answers 5xx when a tenant sweep throws, or when every candidate of a sweep threw. Alert on it.
5. **Migrations.** Every tenant has applied tenant migration `0006_add_sub_agent_bridge` (see [Before enabling](#before-enabling)).
6. **Shutdown signal.** SIGTERM reaches the Next process. In the Enterprise image, Next runs inside PID 1 (`start-server.cjs`). `terminationGracePeriodSeconds` must be at least preStop + the 25 s worker pause budget + the p99 single-step duration. After-response work gets another 30 s (`after_response.settle_timeout`).
7. **Capacity.** With tenant quotas removed, worker slots are the only concurrency limit: `HATCHET_STEP_SLOTS` and `HATCHET_DELIVERY_SLOTS`, 50 each per process by default. A step still queued after 60 minutes fails, and a direct delivery fails after 24 hours. Configure queue-wait and backlog alerts on both tasks, plus a scale-out threshold well below those limits. When resources run short, scale out workers or nodes. Do not reintroduce tenant quotas.
8. **Logs.** Log collection captures these structured events:
   - `hatchet.worker.started`, `hatchet.worker.restarting`, `hatchet.worker.stopped`, `hatchet.worker.not_ready`, `hatchet.worker.loopback_ready`
   - `after_response.settle_timeout`
   - `agent.async_tool_resume.republished`, `agent.async_tool_resume.republish_exhausted`
   - `subagent.bridge.rejected`

## Before enabling

- Every tenant has applied tenant migration `0006_add_sub_agent_bridge`. In Hatchet mode the sub-agent bridge writes its binding before it schedules a child's first step, and fails without the table.

## Drain before switching off or rolling back

Hatchet holds work that no other mode can see. Before you turn Hatchet delivery off or roll the image back, keep pods with Hatchet enabled running until all three conditions hold:

1. `cpc-agent-step` has no run in QUEUED, RUNNING or SCHEDULED.
2. `cpc-delivery` has no run in QUEUED, RUNNING or SCHEDULED.
3. For every tenant, this query returns no rows:

   ```sql
   SELECT id FROM agent_operations
   WHERE status = 'running'
     AND metadata->'asyncToolResumeIntent'->>'state' = 'pending'
   ```

Skipping the drain loses whatever was still in Hatchet:

- parked async-tool and human resumes
- delayed goal advances
- task heartbeat ticks
- widget runs
- webhooks
- thread and sub-agent callbacks

A plain step is recoverable. The local reaper can redrive it while its Redis state lives, which is 2 hours, refreshed on every attempt.

## Roll back to the base image

The base build's migration preflight rejects a tenant whose journal has more rows than its own chain (`migration-history-mismatch`), which is every tenant that applied 0006.

- **Temporary rollback.** Run the base build's migration with `--tolerate-tenant-failures`. The strict run fails with `migration-history-mismatch`, and the tolerant run reports the tenants and continues. Plan to return to the Hatchet build without re-running 0006.
- **Permanent rollback.** For every tenant, the schema owner drops the table and removes the 0006 journal row:

  ```sql
  DROP TABLE IF EXISTS agent_sub_agent_bridges;
  DELETE FROM __drizzle_migrations WHERE created_at = 1793362808138;
  ```

  Check that the row you delete is the last one, with that `created_at`, before you delete it. Moving forward to the Hatchet build again re-applies 0006.

## Known limits

- **Trace after a lost step lock.** A step that commits and then loses its lock still hands off the next step, but it is not added to the operation's trace. The trace partial is a single object, rewritten whole without a version check, so appending to it could drop steps the new owner recorded. The step is still present in messages and in the agent state; only the trace is missing it.
- **No URL binding on signature verification.** The qstashAuth routes verify the body hash and the signature, but not the URL: the URL the request was signed for differs from the URL the route sees behind the proxy and the tenant routing. A signed request can therefore be replayed to another qstashAuth route within the token's 300 s lifetime. External webhooks are delivered unsigned for this reason.
