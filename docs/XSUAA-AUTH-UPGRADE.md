## XSUAA OAuth upgrade to 1.2.0

This update addresses [GHSA-6935-r3wv-f646](https://github.com/arc-mcp/arc-1/security/advisories/GHSA-6935-r3wv-f646)
by using `@arc-mcp/xsuaa-auth` 1.2.0. A new authorization flow displays **Approve and continue**
or **Deny** before XSUAA sign-in, including when an SSO session already exists. Read the client
name and return address before approving. An ordinary MCP reconnect or token refresh does not
start a new authorization flow; a client that restarts authorization will show approval again.

Upgrade **all replicas**, restart any sign-in already in progress, and use Node.js 22 or later.
Keep the public OAuth URL on one canonical origin; approval cookies and the callback must reach
that origin. The update does not revoke previously issued access or refresh tokens. If exposure
is suspected, follow your identity provider's session/token revocation procedures separately.

XSUAA's `oauth2-configuration.redirect-uris` must contain only this server's exact
`https://<your-app-route>/oauth/callback` address (and explicitly needed development callbacks).
MCP client return addresses belong to the proxy's client-registration policy, not XSUAA's list.
Do not add wildcard CF domains or client URLs to XSUAA to resolve a sign-in error.

The repository MTA now supplies the module's `${default-url}/oauth/callback` to its managed
XSUAA service. If you use a custom domain/public URL or an extension descriptor, override that
resource's `parameters.config.oauth2-configuration.redirect-uris` with the exact canonical
callback too. Check the effective service configuration after deployment; older extension
descriptors can override the new defaults.

### Existing consuming applications

This project also reads `xs-security.json` (or `XS_SECURITY_JSON_PATH`) as its **runtime MCP
client return-address allowlist**. That compatibility behavior is retained. The MTA override
above restricts only the managed XSUAA service; it does not replace the runtime allowlist.
For a consuming app or manual `cf push`, keep that client-policy file and create a **separate**
service-configuration copy containing only the server callback. Apply that copy using
`cf update-service <your-xsuaa-instance> -c <service-security.json>`. Do not point
`XS_SECURITY_JSON_PATH` at the server-only copy: that would reject your MCP clients.

The custom adapter keeps its existing PKCE checks, client-bound code envelope, refresh-token
ownership checks and supported client authentication methods. It now lets the library validate
browser approval before wrapping the approved code. No redirect allowlist entry skips consent.

### Before completing a production rollout

In a non-production deployment, register a client, try Deny, then approve with an existing
SSO session. Complete token exchange and reconnect/refresh from the MCP client. Confirm the
expected tool list and role restrictions; do not perform writes just to test authentication.
Local regression tests cover synthetic HTTP sign-in without contacting SAP. Real XSUAA/IAS
tenants, custom routing and provider session behavior still need an operator smoke check.
