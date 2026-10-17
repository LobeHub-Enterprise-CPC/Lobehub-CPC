# Gateway tenancy protocol 1

This directory freezes the cross-language contract for the tenancy implementation. It is a specification and fixture set, not evidence that the current binary implements it. A build without the complete strict contract must not serve multitenant traffic. The upstream protocol baseline remains the two commits in the project README; tenancy protocol 1 is distinct from agent stream protocol 1. Agent mux/stream protocol 2 is disabled.

`protocol.json` is the machine-readable route, capability and safe-error catalogue. `schema.json` defines wire shapes; `fixtures/*.json` contains positive and negative examples. Binding, source, lease and gate examples can be structurally valid JSON yet must be rejected in their supplied context. Schema validation alone is not authorization. The normative Work requirements live in ENT `docs/specs/tenant-isolation/functional/09-gateway.md`.

## Wire conventions and trust

JSON uses camelCase except signed JWT claims, which use the exact snake_case names below. All wire `*At` timestamps are integer Unix milliseconds; JWT `iat`, `exp`, optional `nbf` are NumericDate seconds. Versions are positive integers up to 2147483647, using the existing lifecycle `acceptedVersion`. Tenant IDs use the existing `[A-Za-z0-9_.:-]{1,128}` grammar, not a new UUID restriction. Generation and requestSeq are positive safe integers; counters are nonnegative safe integers. All fields in a discriminated request are required unless that variant explicitly marks them optional. Unknown action, capability, route and executable message are rejected. Opaque business event/result payloads retain their existing protocol schema and are never treated as authority.

A service/admin HTTP request carries exactly one `X-LobeHub-Gateway-Tenancy: 1` and `X-LobeHub-Tenant-Id`. Reject missing, empty, repeated, comma-joined or malformed tenant headers, or conflicting body/query tenant. Authenticate SERVICE_TOKEN or ADMIN_TOKEN before using a tenant; they are separate deployment credentials. Tenant business success echoes both headers; clients validate them before consuming data. Mutation/dispatch HTTP also requires `X-LobeHub-Tenant-Version` with the original execution version. The JSON execution envelope carries the same value as `sourceAcceptedVersion`; conflicts are errors. Capabilities exposes only version/function names, with no tenant data. Root health retains its existing non-business purpose.

Public URLs are `<base>/{agent-gateway|device-gateway}/tenant/v1/...`. Internal Go routes retain `/tenant/v1/...`; a proxy removes only the outer gateway prefix. Base URL adapters append the tenancy prefix exactly once. No legacy fallback, header-only compatibility or implicit default tenant is permitted, including single-tenant instances. Old business routes return HTTP 426 `GATEWAY_TENANCY_REQUIRED` before state creation. A new client encountering an old binary's 404/failed handshake maps that locally to `GATEWAY_TENANCY_UNSUPPORTED` and stops automatic downgrade/retry on the permanent incompatibility.

## Dedicated ticket and source identity

The JWT protected header requires `alg: RS256` and a configured supported `kid`. Trust only configured JWKS/static keys, never JWT-supplied issuer/jku URLs. Require finite `iat`/`exp`, validate optional `nbf`, bounded clock skew and maximum ticket lifetime of 300 seconds. Check signature and exact `iss=urn:lobehub:gateway-session`, `aud=urn:lobehub:gateway:agent|urn:lobehub:gateway:device`, `purpose=gateway-connect`, `tid`, `sub`, `principal`, `authorization_id`, `accepted_version`, `jti`, `capabilities`. Agent tickets require `operation_id`. For user principals `principal.id == sub`; workspace principal.id is the workspace and sub remains the actual authorized actor. Capabilities are a trusted intersection, not caller-selected permissions: agent:observe, agent:respond, agent:execute, device:connect, device:respond. Observe cannot respond or execute.

Ordinary OIDC/id/sandbox/hetero/tunnel tokens cannot connect directly. Conversely gateway-connect tickets cannot authorize ordinary Work tRPC/OpenAPI/OIDC business APIs. Nested hetero/sandbox business tokens preserve their existing purpose. Never log/store raw credentials in fixtures, snapshots or source records. Test ticket strings are placeholders; signature tests generate ephemeral keys rather than treating fixture strings as valid JWTs.

Work stores immutable bounded authorization records in its existing tenant Redis namespace: authorizationId, tenant, subject, principal, audience, allowed resources/actions/capabilities, exact original source reference, sourceAcceptedVersion and authRecordExpiresAt. Missing/expired records fail closed; JWT validity does not reconstruct them. Sources are private server context, never a browser-supplied sessionId/grantId or public client API argument.

| Source | Trusted reference and direct checks on mint/authorize | Renewal/revocation |
| --- | --- | --- |
| Session | Verified Better Auth persistent auth_sessions.id + user; direct row, expiry, account and resource permission checks; cookie/secondary caches are insufficient | Reauthenticate the original source; deletion/expiry/account restriction invalidates its lease within 30 seconds |
| API key | Matched apiKeys.id, hash fingerprint, user/workspace; same row exists/enabled/unexpired, fingerprint/scopes and current permissions | FullAccess for device registration; restricted keys cannot gain whole-user/device scope via `/me`; separately revalidate each key |
| OIDC access JWT | Issuance-time jti projection: tenant, issuer, clientId, subject, grantId, accessTokenExpiresAt and optional bound session; verify JWT then this exact grant/client/account/session and permissions | Grant/refresh revocation, client disable/delete, bound-session invalidation and account revocation are required; new refresh/login creates a new projection |
| Background operation | Durable tenant+operation owner/principal, allowed state/resource and original execution version from an authorized server run | Parent/operation/account/permission revocation or lifecycle change stops it; independent server operation need not end merely because one browser logs out |

OIDC projection is created at `formats.customizers.jwt` for approved gateway-capable sources, using trusted token.grantId and the structured token's exact jti/exp/subject. Do not assume JWT-format access tokens have adapter AccessToken rows. Missing projection returns `SOURCE_UNVERIFIABLE` and requires refresh/login; it is not an optional desktop feature. Projection failure must prevent issuance of an access token advertised as gateway-exchangeable. This contract does not introduce an OAuth single-JWT revocation protocol or assume the provider supports it. The required grant/refresh/client/bound-session/account revocation paths must invalidate source authorization. If a supported individual-token revocation path exists, it must also invalidate that exact jti projection. A short TTL is not evidence of revocation support.

## Work HTTP interfaces

`POST <tenant-entry>/api/v1/gateway/identity` uses normal existing Work authentication/tenant admission and resource checks. Its trusted identity response is schema `identityResponse`: tenancyProtocol, tenantId, userId, principal, capabilities, authorizationId, acceptedVersion, gatewayTicket, ticketExpiresAt, authRecordExpiresAt. The request is `identityRequest`: tenancyProtocol and audience, operationId required for agent, optional workspaceId selecting an intended workspace subject to existing permissions (otherwise derive personal principal). These are untrusted resource selectors, never a supplied tenant/source/capability. Optional `renewAuthorizationId` makes this a renewal: require an existing unrevoked, unexpired authorization with the exact tenant/subject/principal (including workspace)/audience/operation and actual authenticated source kind + reference. Recheck the original source; never substitute another session, API key, OIDC jti or operation. Issue a fresh jti and bounded deadlines under the **same authorizationId**, atomically replacing the old record; mismatches, absent/revoked/expired records and failed source verification use SOURCE_UNVERIFIABLE without falling back to new mint. The client must reject a response whose authorizationId changes. On successful renewal recompute and extend authRecordExpiresAt within the original source validity and the existing record upper bound (300 seconds per issuance here); ticket lifetime remains at most 300 seconds. Repeated renewals may pass the initial record deadline while the same source remains valid; never extend beyond session/API-key/OIDC grant/access/bound-session/operation validity. Clients with an original IdentityProvider renew at the midpoint of the absolute ticket/record remainder, no later than the conservative clock margin; send auth renewal on the same actual socket and publish the candidate only after gateway auth_success increments the generation. Abort old timers/candidates on disconnect or generation change; transient failures retry only before the original cutoff, permanent failures terminate, and expiry/sleep cannot revive old authority. No provider means no locally invented renewal. During the identity-response-to-auth-frame handoff, an existing socket may still perform action=renew with its previously signed, unexpired gateway ticket under the same immutable authorization/source/principal/audience/operation/version/capabilities. This is not a new connect: connect still requires the current ticket jti. Work returns the presented ticket's own ticketExpiresAt and caps the lease by that deadline, current source validity and current authRecordExpiresAt; a refreshed record never extends an old ticket. Source or record revocation rejects both tickets immediately. With no renewAuthorizationId, this is an initial mint. It always issues the dedicated ticket, never just a user identity. No `/me` result authorizes device registration. Personal/workspace and operation request intent follow existing permission rules; capabilities cannot be expanded by request fields.

HTTP errors use `error` (`{tenancyProtocol,tenantId?,error:{code,message}}`); WS errors use `wsError` (`{type,tenancyProtocol,tenantId?,connectionGeneration?,code,message}`). Messages are bounded safe text with no raw source/credential/business data. During auth use auth_failed/auth_expired or tenant_unavailable and close; disabled capabilities use capability_failed. The catalogue's wsEvent/wsClose applies to handshake rejection, while existing runtime request correlation conveys dispatch errors without granting permission. HTTP status and safe code are authoritative, never a success-shaped body.

Go tokenType=apiKey may exchange only at this fixed endpoint on explicitly allowed Work origins/tenant entry paths. Prohibit URL userinfo, disallowed scheme/host/port, arbitrary suffix, redirect, unbounded response/timeout and WS-chosen callback URL. `LOBE_API_BASE_URL` and origin allowlist retain this purpose. Separate `LOBE_API_INTERNAL_URL` targets a trusted root Work service for the following fixed POST routes; internal requests also forbid redirects and bound time/body size.

| Route | Request / response schema | Authority |
| --- | --- | --- |
| `/api/internal/gateway/admission` | admissionRequest / admissionResponse | SERVICE_TOKEN, limited platform directory/lifecycle read, may report frozen/offline; never opens tenant business DB or grants execution |
| `/api/internal/gateway/authorize` | authorizeRequest / authorizeResponse | SERVICE_TOKEN first, dedicated ticket/source checks and fresh lifecycle (`maxAgeMs=0`), then tenant business context |
| `/api/internal/gateway/tool-result` | callback / callbackAck | SERVICE_TOKEN then runInTenant; original source/attempt, resource permission and actual executor binding must match before settling the original waiter |
| `/api/internal/gateway/finalize-abandoned` | finalizeRequest / callbackAck | Same admission/source/version checks, reuse existing abandon core; no lifecycle bypass |

The root Next shell `/api/internal/gateway/[[...route]]/route.ts` and root Hono mount expose only these routes. Add only the exact `/api/internal/gateway` routing exemption. `/t/{slug}/api/internal/**` stays rejected; other tenantless business APIs and arbitrary `/api/internal` paths gain no exemption. Public ingress denies all Work internal routes.

Authorize action variants are `connect`, `renew`, `dispatch`, `result`. Common request fields: tenancyProtocol, tenantId, authorizationId, expectedPrincipal, audience, action, generation, requestSeq; operationId is mandatory for agent audience. Connect/renew additionally require ticket; dispatch/result additionally require sourceAcceptedVersion, attemptId and dispatchBinding `{connectionId,connectionGeneration,authorizationId}`. Dispatch has a trusted original Work attempt, not an arbitrary service-created JSON command. The authorizationId in the binding equals the connection's target authorization; the Work attempt separately retains the business actor/source and current resource permission. Device enroller permission alone cannot authorize another actor's command.

Response fields are tenantId, authorizationId, principal, audience, action, operationId when applicable, acceptedVersion, ticketExpiresAt, authRecordExpiresAt, leaseExpiresAt, checkedAt, requestSeq, generation. Dispatch/result responses additionally echo sourceAcceptedVersion, attemptId and dispatchBinding. A successful dispatch response means the Work claim was atomically obtained for this exact attempt/binding, authorizing at most one send; repeated calls cannot obtain a second send permission. Result revalidation verifies the original claim; it does not acquire permission to send again. No active success response is returned on failure.

## WebSocket confirmation and leases

Auth frame is `{type:'auth',tenancyProtocol:1,tokenType:'jwt'|'apiKey',token,serverUrl?}`. serverUrl is only an allowlisted Work entry for the API-key exchange, never an internal callback target; JWT verification does not trust it. Repeated auth on a live socket is ticket renewal with the same identity/principal/version and returns auth_success with the incremented generation; periodic online revalidation uses lease_update. Expected tenant/principal/operation and connection identifiers in the URL/client context are hints compared to verified identity; they grant no authority. `auth_success` and `lease_update` have the same explicit fields: type, tenancyProtocol, tenantId, principal, **audience**, roles (the capability strings), acceptedVersion, connectionGeneration, ticketExpiresAt, authRecordExpiresAt, leaseExpiresAt. Audience must equal the requested service, not merely a syntactically valid audience. Bind every frame listener to the actual current socket. Before validated auth_success no connected state, execution, cache mutation or visible hub/operation attachment is permitted.

Three deadlines are distinct: ticketExpiresAt is signed exp; authRecordExpiresAt is the source record TTL bounded by source lifetime; leaseExpiresAt is this direct source/permission/lifecycle check, at most 30 seconds. Work directly checks source and fresh lifecycle on every authorize. For local monotonic M0 and wall W0 at request start, response arrival M1 and conservative bounded skew δ:

```text
D = M0 + min(30000,
             leaseExpiresAt - W0 - δ,
             ticketExpiresAt - W0 - δ,
             authRecordExpiresAt - W0 - δ)
remaining = D - M1
```

Reject remaining<=0, malformed/missing deadlines, binding mismatch or clock anomaly. Admission control leases use the same request-start cap without user-ticket deadlines. Never start another 30 seconds at response/frame reception. Go publishes its effective absolute lease deadline after this deduction. At frame reception clients compute `Dclient = Mrecv + min(30000, leaseExpiresAt-Wrecv-δ, ticketExpiresAt-Wrecv-δ, authRecordExpiresAt-Wrecv-δ)` using Go's already deducted absolute deadlines, and reject nonpositive remaining time. A response to a client-initiated auth/renew additionally retains that local request-start cap; unsolicited lease_update has no invented client request start. This never extends the absolute server deadline. Clock continuity/skew must be provable; a changed wall clock cannot turn an expired frame into permission. A delayed lease_update, sleep/resume, backwards clock change or uncertain monotonic continuity requires conservative expiry/revalidation before executing queued work. Check the deadline synchronously on admission, dequeue and local client execution; timers alone are insufficient.

No cross-connection authorization-success cache or merged checks in this version. ConnectionAuth binds tenant, source, authorizationId, principal, audience, resource/actions, generation and latest requestSeq. Checks are serialized; seq still handles cancellation, timeout and renewal races. A newer denial invalidates the generation immediately; an older success cannot reopen it. Renew a candidate separately, then atomically replace only if the same current socket/identity/principal/version remains live; increment connectionGeneration and invalidate queued, not-yet-started old-generation work. A closed/rejected connection needs a new connection. Already dispatched results may settle only their original pending attempt after revalidating that original source/target and permissions; a fresh source cannot substitute. Otherwise terminate executionUnknown.

## Execution intent, attempt and fence

Execution version is captured once at trusted Work admission when intent forms. It is not endpoint.version, ticket exp, generation or a new counter. Persist it in TenantScope, operation state/metadata, notifier, HTTP envelope, local/Redis/QStash queue payloads and retries. Do not stamp the current scope version on old queued commands, even after active renewal. Missing original versions are rejected/interrupted without clearing stored queues. Legitimate continuation requires new authorization and a new attempt.

Every remote command dispatch uses `executionIntent`: tenancyProtocol, tenantId, sourceAcceptedVersion, actor `{subject,sourceRef}`, targetPrincipal, action, operationId when relevant, resourceId, attemptId, attemptExpiresAt. toolCallId is present for tool results. Work creates the immutable trusted attempt before sending; sourceRef is an opaque Work-ledger reference, never a credential or caller assertion. The gateway freezes `dispatchBinding` from the actual authenticated executor socket. Work atomically claims the attempt for it, then Go rechecks current lease/version/fence/generation/pending under the same gate used by suspension immediately before the bounded socket write. Never hold this gate over network authorization or ordinary callbacks.

WS commands/responses keep their existing typed business fields at the same level, adding the required tenancyProtocol, tenantId, sourceAcceptedVersion, attemptId and connectionGeneration; preserve operationId/toolCallId/requestId when applicable (`dispatchCommand`/`dispatchResponse`). These are compared to the current socket and original pending; they do not expose or replace Work's private actor source. Device synchronous HTTP results use `dispatchResult` and are checked against the same original attempt and trusted binding, never only success=true. Only dispatch-capable HTTP mutations add an `intent` field alongside their existing body; stream-only init/push/update carry the original execution version and immutable owner but do not acquire an external executor claim merely to publish an event. An event carrying a command cannot bypass the command dispatch claim.

Wire attempt outcomes: `cancelledBeforeDispatch`, `interrupted`, `executionUnknown`, `completed`. An accepted remote agent-run acknowledgment is not completion. Replays of claimed/terminal attempts query their state; they do not execute again. Lost Go pending/restart, a write with uncertain delivery or crash after claim before write becomes executionUnknown with no automatic replay. This deliberately does not claim exactly-once external execution.

Callback fields bind tenant, sourceAcceptedVersion, operationId, toolCallId, attemptId, outcome, dispatchBinding and opaque result. Binding is supplied/checked by the gateway against the actual responding socket, never trusted from a self-reported executor field. Original Work attempt verifies the actor/source independently. A late response cannot settle a replacement waiter. Existing tenant Redis prefixes remain, while local resultKey adds operationId+toolCallId+attemptId. Finalize with kind `executor-attempt` uses the same original-version/attempt/executor checks. Cross-tenant nonexistence and foreign-resource lookup return the same 404 shape.

### A1: server-only operation watchdog finalization

`finalizeRequest` is a discriminated union. `kind: 'executor-attempt'` retains the original required attemptId and dispatchBinding. `kind: 'operation-watchdog'` prohibits both fields and requires tenancyProtocol, tenantId, operationId, ownerPrincipal, sourceAcceptedVersion, and watchdog `{lastEventAt,firedAt}` (Unix milliseconds). No executor connection or claim is invented for a stream-only operation. Only the gateway's own watchdog may construct this request for its nonterminal operation, using immutable owner/version from the operation record created by trusted Work-authorized init and its own event/watchdog timestamps. Client and observer frames cannot create this authority.

Work authenticates the service first, parses tid, and enters the normal runInTenant gate. Frozen/offline tenants still reject; Go retains the finalize for retry or terminates local state during suspend, whose acknowledgment never waits for this callback. In the admitted tenant database Work matches the durable operation's owner and original sourceAcceptedVersion against the request; absence, foreign tenant, owner mismatch and source-version mismatch use the same safe RESOURCE_NOT_FOUND response. It then delegates liveness/finalization to AbandonOperationService. Watchdog timestamps must be well formed with firedAt >= lastEventAt; they do not replace persisted authority.

Cleanup itself (marking abandoned/terminal and releasing waiters) may cross lifecycle versions because it creates no new execution. `resumeAbandonedParent` is new execution: it is permitted only when the operation's original sourceAcceptedVersion equals the current acceptedVersion. Otherwise the parent is interrupted with EXECUTION_UNKNOWN and is not automatically resumed. Any claimed unsettled attempts of the finalized operation become executionUnknown, never successful. The callbackAck outcome additionally admits `finalized`, `already_terminal`, `still_running`, or `rejected`; a watchdog acknowledgment omits attemptId, while executor-attempt finalization echoes its attemptId. Ordinary tool-result acknowledgments retain their four attempt outcomes and required attemptId. These rules are owner ruling 035's explicit A1 amendment, pending the integrated result review; they do not widen ordinary callback authority.

Go PrincipalKey is `{TenantID,Kind,ID}`; OperationKey is `{TenantID,OperationID}`. All hubs, pending, owner/seen indexes, replay/cleanup/watchdog, admin aggregates/errors/pagination and persisted counts partition by tenant. Allocate only provisional connection state before auth; do not insert visible hubs/operations, attach, replace or increment tenant stats. Agent init fixes the trusted immutable owner; identical owner re-init is idempotent without clearing terminal/counters; different owner is a conflict.

First tenant use, restart or unknown/higher version consults Work admission before opening a gate. Incoming HTTP versions and snapshots never authorize a tenant. Maintain acceptedVersion high-water marks; stale active/control responses cannot undo a higher fence. Same-version older success cannot undo a closed generation. Resume needs fresh authoritative active admission and new authorization.

## Lifecycle acknowledgment

`tenantSuspend` carries tenancyProtocol, tenantId, eventId, acceptedVersion from the claimed lifecycle event; never look up a later version and stamp it on an old event. Work lifecycle stage 2 passes immutable `{tenantId,eventId,acceptedVersion}` through closeRealtime and waits for local closure and both configured gateways. A configured unreachable gateway fails with existing `LIFECYCLE_STOP_FAILED`; it is not skipped.

Go first installs the version fence under the dispatch gate, stops admission/dequeue, cancels queues, invalidates leases/generations, closes connections and makes pending attempts terminal/unknown. `suspendAck` is `{tenantId,acceptedVersion,outcome:'fenced-and-closed',cancelledBeforeDispatch,executionUnknown}`. Work must validate tenant, exact event version, outcome and count types. Ack means no old request can still be admitted/dispatched and local pending is settled; it does not undo external side effects or prove a remote process stopped. Unconfirmed remote effects are executionUnknown. A superseded old event cannot close current higher-version connections.

Ack never waits for ordinary tool-result/finalize callbacks to succeed. Frozen/offline Work still denies those callbacks via runInTenant. Every web or independent worker owning a waiter/claim must receive cancellation (AbortSignal/equivalent, propagated across processes or observed by bounded authoritative lifecycle revalidation rather than only a web-local signal), settle its local wait and release its claim without business callback success; then existing stop/drain can complete. Do not persist business results through a control-plane bypass. Existing lifecycle failure catalogue and bounded stop/drain limits remain unchanged.

## Snapshot and deployment invariants

Keep each service's existing two snapshot files and service-specific state, but encode `{formatVersion:2,tenants:{[tenantId]:state}}`. Include per-tenant seen/session/error/aggregate history; never active authorization, JWTs or default tenant. An absent file means a new deployment; unreadable/invalid/unknown-version/wrong-tenant state fails startup and propagates failure to main. Write by temp file, sync and atomic rename. Do not overwrite the last usable original on parse failure.

Existing v1 requires an offline backup+hash, verified single-tenant ownership including aggregate/dedup state, explicit tenant mapping and output to a new path. Unknown/mixed ownership blocks automatic migration; preserve the original offline. An authorized data-disposition decision may choose a distinct empty v2 path while retaining original history; this is not authorization to clear it. JSON migration adds no SQL/migration table. Old binaries must never mount v2 real data; test incompatibilities on isolated copies only.

Both public and internal ingress enforce `/tenant/v1`. Work, independent worker and Admin target persistent strict ingress, not raw Go listeners. Public ingress allows only supported user WS plus necessary health/capabilities and denies runtime service/admin/control routes. Internal ingress separates paths/credentials and denies legacy paths before forwarding. Raw Go is reachable only by ingress (for example shared ingress network namespace with loopback binding, or demonstrated equivalent network policy); merely removing published ports is insufficient. Prelaunch manifest validates binary tenancy/bind capability and snapshot format before any listener/data mount. An old binary ignoring bind configuration must not start. Coordinated ingress replacement must preserve namespace isolation.

Remove all old public/internal aliases, listener/container/network addresses and worker/Admin overrides at switch. Rollback preserves strict rejection/network policy; incompatible old binaries stay unavailable. Never rewrite `/tenant/v1` to a legacy route. G8 proves actual rendered proxy/Compose/start/rollback rules, mount paths and old-component isolation using harmless isolated substitutes; no actual-host topology is assumed by this contract.

## Frozen package boundaries

These are implementation contracts; declarations below are not added runtime code. Names and DTOs must be consumed consistently by G1–G7. Module layout may follow each repository's existing style; behavioral or wire changes require owner coordination before divergence.

| Package | Owned interfaces / files | Dependencies and excluded writes |
| --- | --- | --- |
| G1 | Both Go auth/config/types/server, facade and main; dedicated verifier, Work internal client, strict routing, bind/startup checks, connection lease sequencing | G0 schema/routes; G1–G3 use one worker or serial handoff because files overlap |
| G2 | Device connection/hub/admin/adminstore; authenticated attach, workspace/clientKinds, gate/attempt/binding, tenant-partitioned snapshot v2 | G1; existing tools/MCP/RPC/message API keep existing allowed payloads; no tunnels/metrics/kick |
| G3 | Agent operation/server/admin/adminstore; immutable owner, single-op roles/replay, one executor, callbacks, v2 | G1; mux/relay/admin observer explicitly rejected |
| G4 | CPC private authSource, dedicated mint, OIDC issuance/projection/revocation, OpenAPI identity; root Next/Hono/proxy wiring; immutable TenantScope version; attempts/notifier/queue/waiter; lifecycle hooks/service; deployment/globalConfig/LLM resolver capability guards | G0; all gateway mint return branches belong here, not G5. No new auth SQL table or edits to merged migrations |
| G5 | Generic TS gateway clients, browser single-operation transport and LLM capability consumption | G4 TS contracts; no ALS dependency in generic clients; no globalConfig/resolver edits owned by G4 |
| G6 | Desktop connection/auth provider/handlers; standalone and embedded CLI login/renewal/queue cancellation; disabled sampler/tunnel | G4/G5 provider and generation contracts; no old-queue replay or client-specific protocol fork |
| G7 | Admin agent/device service+router and response guards | Services constructed from ctx.lobehubDB.tenantId under tenant procedure; no authed global device singleton |

Frozen TS boundary (types are schemas in this directory):

```ts
// Private server-only source, derived by existing authentication, never caller JSON.
type GatewayAuthorizationSource =
  | { kind: 'session'; sessionId: string; subject: string }
  | { kind: 'apiKey'; keyId: string; keyHash: string; subject: string; workspaceId?: string }
  | { kind: 'oidc'; jti: string; subject: string } // resolve issuance projection internally
  | { kind: 'operation'; operationId: string; subject: string };
type GatewayExecutionContext = { tenantId: string; sourceAcceptedVersion: number };
// Server helper: obtains tenant and acceptedVersion from admitted immutable scope.
mintGatewayTicket(input: { source: GatewayAuthorizationSource; audience: Audience;
  principal: Principal; operationId?: string; capabilities: Capability[] }): Promise<IdentityResponse>;
createGatewayAttempt(input: GatewayExecutionContext & {
  source: GatewayAuthorizationSource; targetPrincipal: Principal; action: ExecutionAction;
  operationId?: string; toolCallId?: string; resourceId: string; attemptExpiresAt: number
}): Promise<ExecutionIntent>; // Work generates attemptId, checks permission, records immutable source
// Public generic-client dependency injection; no auth_sessions/grantId/ALS exposed.
type GatewayIdentityProvider = (input: { signal: AbortSignal }) => Promise<IdentityResponse>;
// HTTP send envelope is mandatory for all execution mutations; never synthesized from current scope on retry.
type GatewayExecutionEnvelope = GatewayExecutionContext;
type GatewayDispatchEnvelope = GatewayExecutionEnvelope & { intent: ExecutionIntent };
// Waiter local key is inside the existing tenant Redis namespace.
type GatewayResultKey = { operationId: string; toolCallId: string; attemptId: string };
waitForGatewayResult(key: GatewayResultKey, options: { signal: AbortSignal }): Promise<Callback>;
type GatewayLifecycleContext = { tenantId: string; eventId: string; acceptedVersion: number };
closeRealtime(context: GatewayLifecycleContext): Promise<void>; // waits local + configured Go acks
```

`GatewayIdentityProvider` refresh is bound to the original login generation/source. A request signal aborts stale work; replacing the login source destroys the old connection before any new provider result is applied. HTTP clients consume GatewayExecutionEnvelope explicitly. WS handlers use the actual connection's verified execution binding, never caller-supplied context. G4 owns private source acquisition and full permission intersections; G5/G6 only receive tickets/identity and execution envelopes.

Frozen Go boundary (wire structs map one-for-one to schema definitions, with explicit JSON tags):

```go
type PrincipalKey struct { TenantID, Kind, ID string }
type OperationKey struct { TenantID, OperationID string }
// Wire DTOs: AdmissionRequest/Response, AuthorizeRequest/Response,
// ExecutionIntent, DispatchBinding, Callback, TenantSuspend, SuspendAck.
type WorkAuthority interface {
    Admission(context.Context, AdmissionRequest) (AdmissionResponse, error)
    Authorize(context.Context, AuthorizeRequest) (AuthorizeResponse, error)
    ToolResult(context.Context, Callback) (CallbackAck, error)
    FinalizeAbandoned(context.Context, FinalizeRequest) (CallbackAck, error)
}
// Gate implementation owns tenant version/fence + queue/write ordering.
// Admission/Authorize network calls happen outside the critical section.
type TenantExecutionGate interface {
    Dispatch(context.Context, ExecutionIntent, DispatchBinding, func(context.Context) error) error
    Suspend(context.Context, TenantSuspend) (SuspendAck, error)
}
```

Dispatch callback performs only a bounded actual write after rechecking current ConnectionAuth lease/generation, Work's claim and tenant fence inside the ordering boundary; it must not call back to Work while holding the gate. Errors are typed against protocol.json; no success-shaped fallback. Generation remains connection-local, not a global tenant version. Service HTTP and admin handlers cannot bypass these interfaces' authorization requirements.

All G4 gateway mint branches must be covered: aiAgent user-level issue (reject mux)/single-operation refresh, shareChat issue+refresh (reject shared visitor before operation creation), startOperation, approvalResume, heteroDispatch gatewayToken only, and device workspace mint/share plus personal identity exchange. Keep generic signUserJWT and sandbox/hetero operation tokens unchanged. Root router wiring, both notifier fetch branches, dispatchClientTool/ToolResultWaiter, operation metadata, local/QStash queue and closeRealtime's claimed event all carry the same frozen context.

## Shared fixture consumption and validation

The agreed root is `contracts/gateway-tenancy/v1` in this GW repository. With sibling repositories, CPC/Admin tests may read `../lobehub-gateway/contracts/gateway-tenancy/v1` at local test time. CI/isolated builds use byte-for-byte vendored copies under each repository's `contracts/gateway-tenancy/v1`, copied from a reviewed GW revision with `manifest.json`. No TypeScript/Go production import, submodule or cross-repository build dependency is introduced. Each repository's test setup verifies every SHA-256 in manifest and records the source revision in its own change description; a copy update is an explicit reviewed change, never a silent download. From a sibling repository a maintainer can copy with `cp -R ../lobehub-gateway/contracts/gateway-tenancy/v1 contracts/gateway-tenancy/` after creating the parent `contracts/gateway-tenancy` and ensuring its `v1` destination does not exist, then validate the manifest. This G0 does not modify CPC/Admin files.

Each fixture file is `{contractVersion:1,cases:[...]}`. A case has id, schema (a $defs name), validation (`wire`, `binding`, `source`, `lease`, `gate`), input, optional context and expected `{accepted,code?,outcome?}`. Validate every input against schema; negative wire cases must fail schema, while semantic cases must reach real owning authorization/gate/client logic with the supplied context. Codes come from protocol.json. Implementing a second fake validator that only reproduces fixture expectations is not a test of the runtime. JSON schema cannot prove JWT signatures, actor authorization, source revocation, source→attempt binding, actual socket identity or atomic ordering.

G1–G3 consume token/WS/authorize/dispatch/lifecycle/lease/error cases in Go; G4 consumes token/source/authorize/dispatch/lifecycle; G5/G6 consume WS/binding/lease/capability; G7 consumes protocol/tenant response and ack/error binding as applicable. Runtime acceptance also requires the ENT AC-09 cases, including independent-worker drain, delayed lease_update and sleep/clock anomalies. G0 validates schema/case structure/links/manifests only; actual runtime conformance remains the owning implementation package's required acceptance.
