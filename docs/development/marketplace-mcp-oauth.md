# Marketplace MCP OAuth via installation_details

This integration changes LobeHub only. Market keeps its existing schema, API and SDK.
The existing Manifest pipeline returns each deployment option's `installationDetails`
without stripping extension keys. Configure the following JSON on an HTTP deployment
option in `plugin_deployment_options.installation_details`:

```json
{
  "mcpAuth": {
    "version": 1,
    "type": "oauth2",
    "registration": "dcr",
    "scopes": ["docs:read"]
  }
}
```

Keep any existing installation detail fields beside `mcpAuth`. For Tencent Docs, use
`https://docs.qq.com/openapi/mcp` as the connection URL. Discovery resolves the
resource's authorization server and registration endpoint. Do not put endpoint URLs
in Client ID fields. No Client ID or secret belongs in this public metadata.
`scopes` is required and nonempty: publish the permissions actually needed rather
than silently requesting every scope the provider advertises. Version 1 supports
HTTP + OAuth authorization code with PKCE + DCR only. Unknown versions, malformed
auth declarations and unsupported registration modes fail installation explicitly.

## Installation

1. The installer fetches the existing Market Manifest and selects the HTTP deployment.
2. Existing required string parameters, if any, are collected normally.
3. A Connect and authorize action opens the existing OAuth popup directly from the
   user's click, avoiding browser popup blocking. Desktop uses its native OAuth window.
4. An ordinary marketplace connector is created with the real endpoint and explicit
   scopes. Existing connector OAuth discovery, DCR, PKCE, callback, encrypted token
   storage, refresh and tool sync are reused.
5. Installation succeeds only after the connector reports connected. The plugin row
   stores a connector reference and an empty API list; the runtime resolves the real
   tools and credentials from the connector. This avoids an unauthenticated fallback.
6. Tool sync uses the live connector. Uninstall removes the exact managed connector
   and the plugin marker in one transaction. Provider-side OAuth revocation is not
   implied by deleting local credentials.

No marker means the existing API-key, anonymous HTTP, cloud and desktop stdio
installation paths remain in use. Unsupported old LobeHub clients cannot interpret
this metadata: publish OAuth entries only after compatible clients are available.

## Recovery and limits

DCR rejection rolls back a newly created connector only. Once authorization starts,
the connector remains for retry because the server callback may still complete.
Retry reuses its stored registration instead of overwriting the resolved client ID.
An unrelated connector with the same identifier is never overwritten. Cancel stops
installation; it cannot undo authorization the user already granted to the provider.
The existing desktop authorization window has its own close/timeout lifecycle.

DCR discovery does not guarantee provider admission. QQ Mail's callback allowlist
restriction remains a provider-specific prerequisite; it is not bypassed here.
Tencent Docs has been authorized manually on the existing custom-connector path;
that evidence does not validate this new Marketplace installation path.

## Local verification

Related installation and connector-sync tests cover the OAuth branch, normal MCP
paths, invalid metadata, DCR failure, retry, sync failure, cancellation and connector
identity collisions. Product acceptance must separately exercise this branch on a
running Web/Desktop build, including popup cancellation and actual tool invocation.

## Rollout and rollback

Ship compatible LobeHub clients and lifecycle handlers before publishing OAuth
Market entries. Before reverting these handlers, stop publishing the new entries
and inventory existing `oauthConnectorId` markers. Retain the handlers until those
installations have been migrated or removed through compatible uninstall logic;
older clients cannot synchronize or clean up the new managed records correctly.
Do not copy user tokens into Market or legacy plugin settings during rollback.
