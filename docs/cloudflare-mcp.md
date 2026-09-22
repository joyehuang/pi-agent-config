# Cloudflare API MCP

Configured using the official remote endpoint and OAuth. Merge the following fragment into the shared user MCP configuration; do not replace other server entries:

```json
{
  "mcpServers": {
    "cloudflare-api": {
      "url": "https://mcp.cloudflare.com/mcp",
      "auth": "oauth",
      "lifecycle": "lazy",
      "protocolVersion": "auto"
    }
  }
}
```

The adapter exposes `docs`, `search`, and `execute`. Keep Code Mode enabled rather than registering thousands of endpoint tools.

## Authorization and permissions

Use OAuth through the MCP adapter. Its native OS credential store holds tokens; never put tokens in this repository or chat. Select the intended account and a custom permission set rather than Full access.

The configured scope categories cover the necessary account/user read and offline access, plus DNS, Workers scripts/routes/CI, Pages, KV, R2, D1, Access applications/policies/groups and Tunnel management. Observability/tail is read-only. Billing writes, domain purchases/transfers, membership management and unrelated product administration are excluded.

Granting a write scope is not blanket authorization to perform future writes. Deletion, public access changes, paid operations, and other consequential resource changes still require task-specific authorization.

## Loading and verification

A running adapter reads a configuration snapshot. Adding a new server to disk does not make `mcp({connect:"cloudflare-api"})` discover it automatically; execute Pi `/reload` before using the new gateway server. No need to restart Cloudflare resources.

After loading, connect and discover tool schemas. Use `search` to find the exact endpoints before `execute`. Initial verification should consist only of GET/list operations against zones, Workers, R2 buckets, Access applications and Tunnels. Successful read tests do not establish write capability by execution.

During the initial setup, OAuth and all five read categories were verified through an isolated standard MCP client using the same adapter's URL-bound OAuth credentials; this does not imply the already-running main Pi gateway had reloaded its configuration.

Prefer MCP/API for covered administration, Wrangler for appropriate project builds/deployments, and the browser for user authentication, UI-only operations and visual acceptance. OAuth login screens requiring a passkey or second factor need the user; do not bypass them.
