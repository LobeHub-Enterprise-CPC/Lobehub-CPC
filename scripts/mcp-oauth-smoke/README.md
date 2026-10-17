# Local MCP OAuth smoke page

A small standalone page for protocol verification without starting LobeHub,
Docker, Postgres, Redis or Electron. It imports the production Marketplace
metadata parser and connector OAuth functions from this branch.

```sh
APP_URL=http://localhost:3317 bun scripts/mcp-oauth-smoke/server.ts scripts/mcp-oauth-smoke/tencent-docs-manifest.json
```

Use an actual response from Market's `/api/v1/plugins/tencent-docs-mcp/manifest`
endpoint, not an invented fixture. That public metadata snapshot must include
`installationDetails.mcpAuth`. No Market credentials are needed by this harness.
Open `http://localhost:3317` and click the login action. The DCR request uses this
local callback; provider callback admission may differ from the deployed domain.
No Client ID or Client Secret is entered manually.

The page checks discovery, DCR, PKCE/code exchange, tools/list and an explicit
refresh. The optional real read-only call is limited to `check_skill_update`
without arguments if its returned schema allows that; it never opens documents
or renders private document content. Tokens, PKCE verifiers and client credentials
remain in process memory, per browser session, with single-use 10-minute states
and 2-hour session cleanup. It binds to loopback, checks Host/Origin and keeps
credentials out of status responses. Clear the session or stop the process to
remove its local credentials. Local deletion does not revoke provider consent.

This verifies the shared protocol functions and the real Market metadata. It does
**not** verify LobeHub's Marketplace UI, connector database persistence, encryption,
Redis state store, runtime permissions or transactional uninstall. Those still
need acceptance on a running LobeHub build after the PR is merged/deployed.

## Observed result (2026-10-15)

The included JSON is the real public Market Manifest response retrieved after
publishing `tencent-docs-mcp` version 0.1.0. Using the production helpers, the
local callback completed discovery, DCR, PKCE/code exchange and authenticated
`tools/list`; Tencent Docs returned **225 tools**. No manually entered Client ID
or secret was used. Token refresh and the optional read-only call are separate
checks and were not claimed complete at this point. The snapshot and result do
not establish full application acceptance or authorization to execute all tools.
