# Deploying OData MCP Proxy to SAP BTP Cloud Foundry

Step-by-step guide for building and deploying the OData MCP Proxy as a Cloud Foundry application on SAP BTP.

## 1. Prerequisites

Before you begin, make sure the following are in place:

- **SAP BTP Global Account** with at least one subaccount that has Cloud Foundry enabled.
- **Cloud Foundry CLI** (`cf`) installed and available on your PATH.
  Install via <https://github.com/cloudfoundry/cli#downloads>.
- **MBT (MTA Build Tool)** installed globally:
  ```bash
  npm install -g mbt
  ```
- **Node.js** installed per the [README prerequisites](../README.md#prerequisites). Cloud Foundry staging uses `engines.node` in [package.json](../package.json), matching the [Node.js buildpack default](https://docs.cloudfoundry.org/buildpacks/node/index.html#supported_versions).
- **SAP Integration Suite** subscription in your subaccount with the **Cloud Integration** capability activated.
- **Process Integration Runtime** service instance (plan: **api**) with the required authorization roles (see next section).

## 2. Required Authorization Roles

When you create the Process Integration Runtime service instance (plan `api`), include the following roles in the service key so that the MCP server can access the Cloud Integration OData APIs:

| Role                        | Purpose                                     |
| --------------------------- | ------------------------------------------- |
| `WorkspacePackagesRead`     | Read integration packages and artifacts     |
| `WorkspacePackagesEdit`     | Create and modify integration content       |
| `MonitoringDataRead`        | Read message processing logs and monitoring |
| `WorkspaceArtifactsDeploy`  | Deploy integration artifacts at runtime     |
| `AuthGroup_Administrator`   | Manage security content (credentials, etc.) |

Example service-key parameters:

```json
{
  "roles": [
    "WorkspacePackagesRead",
    "WorkspacePackagesEdit",
    "MonitoringDataRead",
    "WorkspaceArtifactsDeploy",
    "AuthGroup_Administrator"
  ]
}
```

## 3. Create the BTP Destination

In the SAP BTP cockpit, navigate to **Connectivity > Destinations** in the subaccount where you will deploy, and create a new destination:

| Property               | Value                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- |
| **Name**               | Must match the `destination` field in `src/config/api-config.json` (default `CPI_DESTINATION`)         |
| **Type**               | `HTTP`                                                                                  |
| **URL**                | `https://<tenant>.it-cpiXXX.cfapps.<region>.hana.ondemand.com/api/v1`                   |
| **Proxy Type**         | `Internet`                                                                              |
| **Authentication**     | `OAuth2ClientCredentials`                                                               |
| **Token Service URL**  | Copy from the `tokenurl` field in your Process Integration Runtime service key           |
| **Client ID**          | Copy from the `clientid` field in your Process Integration Runtime service key           |
| **Client Secret**      | Copy from the `clientsecret` field in your Process Integration Runtime service key       |

> **Tip:** You can find all of the OAuth fields in the service key you created in the previous step. The Token Service URL typically looks like `https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token`.

## 4. Configure Environment Variables

Configure the destination as described in [Section 3](#3-create-the-btp-destination); its name is selected by the API config, not an environment variable.

All environment variables are optional and have sensible defaults:

| Variable                  | Default   | Description                                            |
| ------------------------- | --------- | ------------------------------------------------------ |
| `MCP_TRANSPORT`           | `http`    | Transport mode (`http` or `stdio`)                     |
| `PORT`                    | `4004`    | HTTP server port (Cloud Foundry assigns this automatically) |
| `LOG_LEVEL`               | `info`    | Logging level (`error`, `warn`, `info`, `debug`)       |
| `REQUEST_TIMEOUT`         | `60000`   | HTTP request timeout in milliseconds                   |
| `ENABLED_API_CATEGORIES`  | `all`     | Comma-separated list of API categories to enable       |

For config-file selection (`API_CONFIG_FILE`), production logging (`NODE_ENV`), HTTP CORS (`CORS_ORIGIN`), and the public OAuth origin (`PUBLIC_BASE_URL`), see the [configuration reference](../README.md#configuration).

> **Note:** On Cloud Foundry the `PORT` variable is set automatically by the platform. Do not override it.

## 5. Build and Deploy

Log in to Cloud Foundry and deploy:

```bash
# 1. Log in (use --sso for single sign-on, or provide user/password)
cf login -a <api-endpoint> --sso

# 2. Target the correct org and space
cf target -o <org> -s <space>

# 3. Build the MTAR archive
npm run build:btp

# 4. Deploy to Cloud Foundry
npm run deploy:btp
```

Under the hood these scripts run:

- `build:btp` --> `mbt build` (produces an `.mtar` file in `mta_archives/`)
- `deploy:btp` --> `cf deploy mta_archives/*.mtar`

The MTA deployment will automatically create or update the following service instances (defined in `mta.yaml`):

| Resource Name            | Service        | Plan          |
| ------------------------ | -------------- | ------------- |
| `odata-mcp-proxy-destination`   | destination    | lite          |
| `odata-mcp-proxy-connectivity`  | connectivity   | lite          |
| `odata-mcp-proxy-xsuaa`         | xsuaa          | application   |

## 6. Post-Deployment

### Assign roles to users

The XSUAA configuration (`xs-security.json`) defines three role templates:

| Role Template  | Scopes              | Use Case                  |
| -------------- | -------------------- | ------------------------- |
| **MCPViewer**  | `read`               | Read-only access          |
| **MCPEditor**  | `read`, `write`      | Read and modify content   |
| **MCPAdmin**   | `read`, `write`, `admin` | Full administrative access |

To assign roles:

1. In the **SAP BTP cockpit**, go to **Security > Role Collections**.
2. Create a role collection (or use an existing one).
3. Add the appropriate role template(s) from the `odata-mcp-proxy` application.
4. Assign the role collection to the relevant users or user groups.

### Verify the deployment

```bash
# Check application status
cf app odata-mcp-proxy

# View recent logs
cf logs odata-mcp-proxy --recent
```

The output of `cf app` will show the application route (URL), status, and instances. Confirm the health check passes and the state shows `running`.

You can also verify the health endpoint directly:

```bash
curl https://<app-route>/health
```

### View live logs (optional)

```bash
cf logs odata-mcp-proxy
```

## 7. Connecting MCP Clients

Once deployed, the server exposes the Model Context Protocol over HTTP at:

```
https://<app-route>/mcp
```

Where `<app-route>` is the URL shown in the `cf app odata-mcp-proxy` output (under `routes`).

Configure your MCP client to connect to this URL. See the [HTTP transport reference](../README.md#http-streamable-http) for HTTP startup and binding policy, and [Operation Scopes](../README.md#operation-scopes) for tool-level authorization.

### OAuth discovery and client registration

Inbound OAuth uses `@arc-mcp/xsuaa-auth` with the MCP SDK router. OAuth-capable MCP clients can discover the flow through the bearer challenge's `resource_metadata` URL. Authorization-server metadata is also available at `/.well-known/oauth-authorization-server`; use its advertised endpoints rather than hard-coding the former `/oauth/authorize`, `/oauth/token`, `/oauth/refresh`, or `/oauth/client-registration` routes, which are no longer supported. The server's XSUAA callback remains `/oauth/callback`.

Dynamic registration returns local client credentials, not the bound XSUAA secret. Registration accepts `token_endpoint_auth_method: "none"` for public clients or `"client_secret_post"` for confidential clients; omitting it explicitly registers and returns `"client_secret_post"`. Unsupported methods, including `"client_secret_basic"`, are rejected with `invalid_client_metadata`. Confidential clients send `client_id` and `client_secret` in the form body, not HTTP Basic authentication.

Clients must use S256 PKCE. The proxy verifies the authorization code's client and redirect binding and the `code_verifier` before exchanging with XSUAA; confidential clients must also authenticate. Send token requests by POST to the discovered token endpoint; GET is rejected. Refresh uses the same endpoint with `grant_type=refresh_token`, and the refresh token is bound to the client that obtained it. Treat codes and refresh tokens as opaque proxy values, not raw XSUAA grants. Explicit upstream `invalid_grant` rejections return HTTP 400 `invalid_grant`; network, transport, and upstream server failures remain server errors.

A client with an independently obtained valid XSUAA access token can instead send it directly as `Authorization: Bearer <token>` on `/mcp`. Destination credentials used for outbound backend calls are separate from this inbound authentication flow.

### Redirect policy and deployment constraints

The authoritative redirect allowlist is `oauth2-configuration.redirect-uris` in an `xs-security.json`, enforced both during registration/authorization and at the callback. The shared package's broader default allowlist is not used. XSUAA sees only the server callback, so the proxy must enforce the client's redirect target itself.

When HTTP authentication is initialized with an XSUAA binding, the runtime resolves which `xs-security.json` supplies that allowlist in this order:

1. `XS_SECURITY_JSON_PATH` — an explicit path, trimmed of surrounding whitespace; relative paths resolve against the process working directory. An unset, empty, or whitespace-only value uses the next source. A non-empty override that is missing, unreadable, or invalid fails startup rather than silently falling back.
2. The running app's own `xs-security.json` in the process **working directory**, if present. A consuming app that runs `odata-mcp-proxy --config …` from its own app root therefore uses its own configured redirects. An unreadable or invalid file fails startup; only an absent file falls back.
3. The proxy package's [bundled `xs-security.json`](../xs-security.json).

The selected list replaces rather than merges with other sources and is independent of the active API config. The server logs the selected source once at startup (path only, not file contents). Each source uses the same redirect-list validation in [src/server/oauth.ts](../src/server/oauth.ts), not a full XSUAA configuration schema. Ensure the server callback and intended client redirects are permitted by the selected security configuration, and use that configuration to provision the XSUAA service instance. Consuming-app redirect coverage for Claude, Teams, Cursor, and MCP Inspector is captured in [test/redirect-allowlist.test.ts](../test/redirect-allowlist.test.ts).

Public URL selection is described in the [configuration reference](../README.md#configuration). Query strings are redacted from HTTP request logs, and untrusted callback error text is HTML-escaped. The proxy disables the SDK's per-IP limits on authorization, token, registration, and revocation endpoints; deployment-level throttling, if needed, is a separate policy. OAuth security regressions are covered in [test/e2e-auth-security.test.ts](../test/e2e-auth-security.test.ts).

## Troubleshooting

| Symptom                            | Likely Cause                                                        | Fix                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| App crashes on startup              | Destination service not bound, or destination missing              | Ensure the app is bound to `odata-mcp-proxy-destination` and the destination exists; restage (`cf restage odata-mcp-proxy`) |
| `401 Unauthorized` from CPI APIs   | Missing roles on the Process Integration Runtime service key       | Recreate the service key with the required roles (see Section 2)                        |
| Destination not found               | Destination name mismatch or missing destination service binding   | Verify the BTP destination Name matches the `destination` field in `api-config.json` (default `CPI_DESTINATION`) and the app is bound to `odata-mcp-proxy-destination` |
| Health check fails                  | App not listening on the assigned `PORT`                           | Ensure you are not overriding `PORT`; the platform assigns it automatically             |
| `mbt build` fails                   | MBT not installed                                                  | Run `npm install -g mbt`                                                                |
| `cf deploy` fails                   | Not logged in or wrong target                                      | Run `cf login` and `cf target -o <org> -s <space>`                                      |
