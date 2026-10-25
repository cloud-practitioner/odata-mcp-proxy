## XSUAA OAuth upgrade to 1.2.0

This update addresses [GHSA-6935-r3wv-f646](https://github.com/arc-mcp/arc-1/security/advisories/GHSA-6935-r3wv-f646)
by using `@arc-mcp/xsuaa-auth` 1.2.0. A new authorization flow displays **Approve and continue**
or **Deny** before XSUAA sign-in, including when an SSO session already exists. Read the client
name and return address before approving. An ordinary MCP reconnect or token refresh does not
start a new authorization flow; a client that restarts authorization will show approval again.

Upgrade **all replicas**, restart any sign-in already in progress, and use Node.js per the
[README prerequisites](../README.md#prerequisites).
Keep the public OAuth URL on one canonical origin; the callback requires the approving browser's
cookie on that origin. The update does not revoke previously issued access or refresh tokens.
If exposure is suspected, follow your identity provider's session/token revocation procedures separately.

XSUAA's `oauth2-configuration.redirect-uris` must contain only this server's exact
`https://<your-app-route>/oauth/callback` address (and explicitly needed development callbacks).
MCP client return addresses belong to the proxy's client-registration policy, not XSUAA's list.
Do not add wildcard CF domains or client URLs to XSUAA to resolve a sign-in error.

The repository MTA now supplies the module's `${default-url}/oauth/callback` to its managed
XSUAA service. If you use a custom domain/public URL or an extension descriptor, override that
resource's `parameters.config.oauth2-configuration.redirect-uris` with the exact canonical
callback too. Check the effective service configuration after deployment; older extension
descriptors can override the new defaults.

### Client registration names

The library derives each client ID from the registration metadata and the current second, so
identical same-second registrations can collide. The adapter now adds a random suffix to
`client_name` (for example `My Client #Xk3...`) on every
registration. Each registration gets its own ID and, for confidential clients, its own secret.
The approval page shows the suffixed name.

### Existing consuming applications

Keep the [runtime MCP client return-address allowlist](DEPLOYMENT.md#redirect-policy-and-deployment-constraints).
The MTA override above restricts only the managed XSUAA service; it does not replace that allowlist.
For a consuming app or manual `cf push`, keep that client-policy file and create a **separate**
service-configuration copy containing only the server callback. Apply that copy using
`cf update-service <your-xsuaa-instance> -c <service-security.json>`. Do not point
`XS_SECURITY_JSON_PATH` at the server-only copy: that would reject your MCP clients.

No redirect allowlist entry skips consent. For PKCE, token binding, and supported client
authentication methods, see [OAuth discovery and client registration](DEPLOYMENT.md#oauth-discovery-and-client-registration).

### Before completing a production rollout

In a non-production deployment, register a client, try Deny, then approve with an existing
SSO session. Complete token exchange and reconnect/refresh from the MCP client. Confirm the
expected tool list and role restrictions; do not perform writes just to test authentication.
Local regression tests cover synthetic HTTP sign-in without contacting SAP. Real XSUAA/IAS
tenants, custom routing and provider session behavior still need an operator smoke check.
