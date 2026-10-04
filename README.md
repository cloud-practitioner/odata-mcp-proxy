# OData MCP Proxy

A config-driven [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes OData and REST APIs as MCP tools. This enables AI assistants such as Claude to query, manage, and monitor SAP backends through natural language.

The server runs on SAP BTP Cloud Foundry and uses BTP Destinations for secure, token-managed connectivity to OData APIs.

---

## Features

- **32 OData entity sets** across 6 API categories, automatically registered as MCP tools
- **Full CRUD support** -- list, get, create, update, and delete operations where the API permits
- **OData V2 query capabilities** -- `$filter`, `$select`, `$expand`, `$orderby`, `$top`, `$skip`, and `$inlinecount`
- **Navigation property traversal** -- dedicated tools for related entities (e.g., iFlow configurations, message attachments, error details)
- **Category-based filtering** -- enable only the API categories you need via configuration
- **Dual transport modes** -- Streamable HTTP for BTP deployment, stdio for local Claude Desktop use
- **Automatic OAuth token management** -- tokens are refreshed transparently via the BTP Destination Service

---

## Architecture

```
Claude / AI Assistant
        |
        | MCP Protocol (stdio or HTTP)
        v
 OData MCP Proxy
        |
        | OData V2 + JSON
        v
   OData Client
        |
        | OAuth2 (via BTP Destination Service)
        v
  BTP Destination
        |
        v
 SAP Cloud Integration
   OData Admin APIs
```

The server resolves a BTP Destination at startup to obtain the Cloud Integration tenant URL and OAuth2 credentials. On each API call, the destination is re-resolved to ensure tokens remain valid. The OData client translates MCP tool invocations into OData V2 HTTP requests and returns structured JSON results to the AI assistant.

---

## Prerequisites

- **Node.js** 22.x (see `engines.node` in [package.json](package.json))
- **SAP BTP account** with a Cloud Foundry environment
- **SAP Integration Suite** tenant (Cloud Integration capability)
- **BTP Destination** configured to point to your Cloud Integration tenant's OData API with OAuth2 authentication
- **Cloud Foundry CLI** (`cf`) and **MBT Build Tool** (`mbt`) for BTP deployment

---

## Quick Start (Local Development)

### 1. Clone and install

```bash
git clone <repository-url>
cd odata-mcp-proxy
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```dotenv
MCP_TRANSPORT=stdio
```

> **Note:** Destination names live in `src/config/api-config.json`, not in an env var. For local development without BTP, set the per-destination OAuth2 credentials (e.g. `CPI_DESTINATION_BASE_URL`, `CPI_DESTINATION_TOKEN_URL`, `CPI_DESTINATION_CLIENT_ID`, `CPI_DESTINATION_CLIENT_SECRET`); see [docs/LOCAL_RUN.md](docs/LOCAL_RUN.md). On BTP, credentials come from the bound Destination service via `VCAP_SERVICES`.

### 3. Build and run

```bash
npm run build        # Rebuild after source edits or an install with scripts disabled
npm run start:stdio
```

Or use the development watcher:

```bash
npm run dev
```

### 4. Connect from Claude Desktop

Add the server to your Claude Desktop MCP configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "odata-mcp-proxy": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/odata-mcp-proxy",
      "env": {
        "MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

---

## Using as an npm Package

You can consume `odata-mcp-proxy` as a dependency in your own project -- similar to how the [SAP Application Router](https://www.npmjs.com/package/@sap/approuter) works. Registry releases include prebuilt `dist/` output, so consumers need no manual build step.

For Git dependencies and source checkout installs, npm's `prepare` hook runs `npm run build` when `src/` exists, generating `dist/` automatically. Keep npm lifecycle scripts enabled; source checkout builds also need the development dependencies. When `src/` is absent, as in a published package or standalone Cloud Foundry staging, the hook skips compilation and uses the prebuilt output.

### 1. Create your project

```bash
mkdir my-mcp-server
cd my-mcp-server
npm init -y
npm install odata-mcp-proxy
```

### 2. Add a start script

In your `package.json`:

```json
{
  "scripts": {
    "start": "odata-mcp-proxy"
  },
  "dependencies": {
    "odata-mcp-proxy": "^1.0.0"
  }
}
```

### 3. Add your API config

Create an `api-config.json` in your project root. The CLI automatically picks it up from the working directory. See the [bundled config files](src/config/) for the full format.

```json
{
  "server": {
    "name": "my-mcp-server",
    "version": "1.0.0",
    "description": "My custom MCP server"
  },
  "apis": [
    {
      "name": "my-api",
      "destination": "MY_DESTINATION",
      "pathPrefix": "/api/v1",
      "csrfProtected": true,
      "entitySets": [
        {
          "entitySet": "Products",
          "description": "product entities",
          "category": "master-data",
          "keys": [{ "name": "Id", "type": "string" }],
          "operations": { "list": true, "get": true, "create": false, "update": false, "delete": false }
        }
      ]
    }
  ]
}
```

The config is validated at startup: an unknown or misspelled key, a value of the wrong type, or an unsupported `method` stops the server with a message naming the offending location (e.g. `apis[0].entitySets[3].operations.update.method`). Duplicate `apis[].name` values, including collisions with defaulted names, are rejected regardless of category filtering. Duplicate MCP tool names or resource URIs are rejected only when they would actually register, accounting for `ENABLED_API_CATEGORIES`, enabled operations, key requirements, and discovery mode. Repeated entity set names are allowed when they produce no effective registration collision. Omitted fields fall back to defaults: `server.version` to this package's version, `apis[].name` to `api<index>` (e.g. `api0`) and `apis[].pathPrefix` to `/api/v1`.

Before starting either transport, the server builds and closes a throwaway MCP session to catch remaining registration failures, such as a UI data source referencing an unknown API. In HTTP mode these failures stop startup before the server listens, rather than surfacing on the first client connection.

Each entry in `entitySets` supports:

| Field | Required | Description |
|-------|----------|-------------|
| `entitySet` | yes | Entity set name, also the tool name prefix (`<entitySet>_list`, `_get`, ...). |
| `urlPath` | no | URL path segment, when it differs from `entitySet` (default: `entitySet`). |
| `description` | no | Human-readable description used in tool descriptions (default: `entitySet`). |
| `category` | no | Category for `ENABLED_API_CATEGORIES` filtering. Without one, the entity set is only enabled when all categories are. |
| `keys` | yes | Key properties: `[{ "name": "Id", "type": "string" \| "number" }]`. `get` and `delete` are only registered when keys are defined. |
| `operations` | yes | `list`, `get`, `create`, `update`, `delete`. Each is `true`, `false`, or `{ "enabled": bool, "requiredScope": "..." }`. An omitted operation is disabled. |
| `filterableProperties` | no | Property names hinted as `$filter` candidates. |
| `selectableProperties` | no | Property names hinted as `$select` candidates. |
| `navigationProperties` | no | `[{ "name": "...", "description": "...", "isCollection": bool }]` (`description` and `isCollection` optional), each registered as `<entitySet>_<name>_list`. |

For `requiredScope` enforcement and navigation-tool authorization, see [Operation Scopes](#operation-scopes).

The `update` operation also accepts `method`: `"PATCH"` (default) or `"PUT"`. Use `PUT` where the API replaces rather than merges, such as Cloud Integration externalized parameters or API Management products:

```json
{
  "entitySet": "IntegrationFlowConfigurations",
  "urlPath": "IntegrationDesigntimeArtifacts",
  "description": "externalized parameters of an integration flow",
  "category": "integration-content",
  "keys": [{ "name": "Id", "type": "string" }, { "name": "Version", "type": "string" }],
  "operations": { "update": { "enabled": true, "requiredScope": "write", "method": "PUT" } }
}
```

Calling `IntegrationFlowConfigurations_update` with path `(Id='MyFlow',Version='active')/$links/Configurations('MyParam')` and body `{ "ParameterValue": "new" }` then sends `PUT /api/v1/IntegrationDesigntimeArtifacts(Id='MyFlow',Version='active')/$links/Configurations('MyParam')`. The method appears in the tool description and in `search_operations` results, and `execute_operation` uses it too.

You can also use a custom filename with the `--config` flag:

```bash
odata-mcp-proxy --config my-custom-config.json
```

Or set it via environment variable:

```bash
API_CONFIG_FILE=my-custom-config.json npm start
```

See [Configuration](#configuration) for the config-file resolution order and bundled default.

### 4. Configure credentials

For local development, create a `.env` file or `default-env.json` with your destination credentials. The env var prefix is derived from the `destination` field in your config -- uppercase it and replace non-alphanumeric characters with `_`.

For example, destination `"MY_DESTINATION"` maps to:

```dotenv
MY_DESTINATION_BASE_URL=https://my-api.example.com
MY_DESTINATION_TOKEN_URL=https://auth.example.com/oauth/token
MY_DESTINATION_CLIENT_ID=...
MY_DESTINATION_CLIENT_SECRET=...
```

On BTP, use the Destination Service instead (credentials are resolved automatically via `VCAP_SERVICES`).

### 5. Project structure

A complete consumer project looks like this:

```
my-mcp-server/
├── package.json          # start script + dependency
├── api-config.json       # your API configuration
├── default-env.json      # local BTP credentials (gitignored)
├── .env                  # local env overrides (gitignored)
├── mta.yaml              # BTP deployment descriptor
└── xs-security.json      # XSUAA config (if using OAuth)
```

### Deploying to BTP as a consumer project

Since there is no build step, the `mta.yaml` is straightforward -- just like the SAP Application Router:

```yaml
_schema-version: "3.1"
ID: my-mcp-server
version: 1.0.0

parameters:
  enable-parallel-deployments: true

modules:
  - name: my-mcp-server
    type: nodejs
    path: .
    parameters:
      memory: 512M
      disk-quota: 1G
      buildpack: nodejs_buildpack
      health-check-type: http
      health-check-http-endpoint: /health
      command: npm start
    build-parameters:
      builder: npm
      ignore:
        - .git/
        - .env
        - default-env.json
    requires:
      - name: my-destination
      - name: my-connectivity
      - name: my-xsuaa

resources:
  - name: my-destination
    type: org.cloudfoundry.managed-service
    parameters:
      service: destination
      service-plan: lite

  - name: my-connectivity
    type: org.cloudfoundry.managed-service
    parameters:
      service: connectivity
      service-plan: lite

  - name: my-xsuaa
    type: org.cloudfoundry.managed-service
    parameters:
      service: xsuaa
      service-plan: application
      path: xs-security.json
```

The key difference from a standalone deployment: `builder: npm` is all you need. MBT runs `npm install --production`, which installs the pre-built `odata-mcp-proxy` package from the registry. No TypeScript, no custom build commands.

Deploy with:

```bash
mbt build && cf deploy mta_archives/my-mcp-server_1.0.0.mtar
```

---

## Interactive UI Views (mcp-ui)

Beyond plain data tools, the config file can declare **interactive UI views**: read-only MCP tools that fetch data through the shared OData clients and return a self-contained HTML page as an [mcp-ui](https://mcpui.dev) embedded resource (with the MCP Apps adapter enabled, so the same widget works on MCP Apps hosts like Claude and on classic mcp-ui hosts).

Add a top-level `ui` array to your API config:

```json
{
  "server": { "name": "my-mcp-server", "version": "1.0.0", "description": "..." },
  "apis": [ ... ],
  "ui": [
    {
      "tool": "UI_SubaccountsOverview",
      "description": "Interactive overview of all subaccounts",
      "uri": "ui://my-server/subaccounts-overview",
      "template": "ui/subaccounts-overview.html",
      "inputs": {
        "subaccountGUID": { "type": "string", "required": true, "description": "GUID of the subaccount" }
      },
      "data": {
        "subaccounts": { "api": "cis-accounts", "path": "subaccounts" },
        "assignments": { "api": "cis-entitlements", "path": "assignments?subaccountGUID={subaccountGUID}", "optional": true }
      },
      "partials": {
        "/*__SHARED_CSS__*/": "ui/_shared.css",
        "/*__SHARED_JS__*/": "ui/_shared.js"
      },
      "frameSize": ["100%", "760px"]
    }
  ]
}
```

Per entry:

| Field | Required | Description |
|-------|----------|-------------|
| `tool` | yes | MCP tool name. Registered read-only (`annotations.readOnlyHint: true`) with `_meta["ui/resourceUri"]` pointing at `uri`. |
| `description` | no | Tool description for the LLM. |
| `uri` | yes | `ui://` resource URI. The template is also registered as an MCP resource at this URI (with `null` data), so MCP Apps hosts that pre-fetch templates can use render-data delivery. |
| `template` | yes | HTML template file, path relative to the config file. File reads are cached. |
| `requiredScope` | no | Optional app-local scope for the view's tool. See [Operation Scopes](#operation-scopes) for enforcement and data-source restrictions. |
| `inputs` | no | Tool parameters: `{ "name": { "type": "string"\|"number"\|"boolean", "required": bool, "default": val, "min": n, "max": n, "description": "..." } }`. Compiled into the tool's input schema. A `default` is applied during parsing, so placeholders referencing that parameter always resolve; `min`/`max` bound number inputs. |
| `data` | no | Named data sources, fetched **concurrently** on invocation through the shared OData client of the referenced `api` (the caller's JWT is forwarded, exactly like the generated entity tools). Placeholders in `path` are substituted with URL-encoded values (see below). `"optional": true` entries fail soft to `null`; a failure in any other entry returns an `isError` tool result. Each source also accepts `paginate` and `select`. |
| `partials` | no | Literal token → file map. Each file (path relative to the config file) is inlined into the template *before* data injection — useful for shared CSS/JS. |
| `frameSize` | no | Overrides the mcp-ui `preferred-frame-size` (default `["100%", "760px"]`). |

### Path placeholders

`{param}` expands to a validated tool argument. `{$...}` expands to a **fixed, closed vocabulary** of derived values — enough for reporting windows and paging without a templating language (there is no eval and no user-defined function):

| Placeholder | Expands to |
|---|---|
| `{$now:FMT}` | The current UTC time. |
| `{$monthsAgo(N):FMT}` | The **first of the month**, `N` months back — so a `yyyymm` window is stable no matter which day the tool runs. |
| `{$daysAgo(N):FMT}` | `N` days back. |
| `{$offset}` / `{$pageSize}` | Page position. Only valid on a source with a `paginate` block. |

`FMT` is `yyyymm` (`202608`), `date` (`2026-08-11`), or `iso` (default). `N` is an integer, the name of a tool input, or that name with one integer offset (`months-1`) — the offset form exists so an *inclusive* window ("the last 6 months, including this one") is expressible, and it is the only arithmetic supported.

```json
"usage": { "api": "uas", "path": "monthlyUsage?fromDate={$monthsAgo(months-1):yyyymm}&toDate={$now:yyyymm}" }
```

Because dates resolve at call time, a view using them is not a pure function of its arguments — expected for reporting windows, worth knowing when caching.

### Pagination

`paginate` repeats the request until the collection is exhausted, a short page arrives, or `maxItems` is hit:

```json
"users": {
  "api": "xsuaa-scim",
  "path": "Users?startIndex={$offset}&count={$pageSize}",
  "paginate": { "strategy": "offset", "pageSize": 100, "maxItems": 500,
                "itemsPath": "resources", "totalPath": "totalResults" }
}
```

| Field | Description |
|---|---|
| `strategy` | `offset` (1-based, SCIM `startIndex`) or `skiptop` (0-based, OData `$skip`). |
| `pageSize` | Items per request, exposed as `{$pageSize}` (default `100`). |
| `maxItems` | Hard cap on accumulated items (default `1000`). |
| `itemsPath` | Dotted path to the item array. Auto-detected (`value`, `resources`, `results`, `content`, `d.results`) when omitted. |
| `totalPath` | Dotted path to the backend's total count, when it reports one. |

A paginated source returns a normalized `{ items, total, truncated, pages }` object rather than the raw response — so templates read `.items`, and **`truncated` tells them the view is showing a capped subset** instead of silently under-reporting.

### Trimming the payload

The payload is baked into the template *and* returned as `structuredContent`, so raw responses reach the model. `select` keeps only the listed dotted paths of each item, preserving the surrounding envelope:

```json
"subaccounts": { "api": "cis-accounts", "path": "subaccounts",
                 "select": ["guid", "displayName", "region", "state"] }
```

**Templates** are full, self-contained HTML/JS pages. The server replaces the token `"__DATA__"` with the JSON payload:

```html
<script>
  const DATA = "__DATA__"; // becomes { view, params, data: { subaccounts: [...], ... } } — or null in the ui:// template resource
</script>
```

`<` is escaped as `\u003c` in the JSON, so user-controlled strings can never close the script tag. Aggregation and reshaping are the template's job — the server side stays declarative (there is deliberately no templating language or server-side aggregation DSL).

The tool result contains a short text summary (tool name + item counts per data entry), the rendered page as an embedded `ui://` resource, and the payload as `structuredContent` for hosts using render-data delivery.

The UI machinery (and its `@mcp-ui/server` dependency) is loaded lazily — configs without a `ui` section skip it entirely.

---

## Progressive Tool Discovery

By default every operation of every entity set becomes its own MCP tool. That is the right thing for a handful of entity sets and the wrong thing at scale: 32 entity sets produce over 100 tools, and the [MCP client best practices](https://modelcontextprotocol.io/docs/2026-07-28/develop/clients/client-best-practices) recommend switching to progressive discovery once tool definitions occupy 1–5% of the context window. Some clients also cap tool counts outright.

Add a top-level `discovery` block and the entity tools collapse into **two stable meta-tools**:

```json
{
  "server": { ... },
  "apis": [ ... ],
  "discovery": {
    "mode": "hybrid",
    "alwaysRegister": ["Subaccounts", "cis-entitlements:Assignments"],
    "maxResults": 25,
    "maxFullResults": 5
  }
}
```

**Omit the block and nothing changes** — registration behaves exactly as before.

| Field | Required | Description |
|-------|----------|-------------|
| `mode` | yes | `search` replaces all entity tools with the meta-tools. `hybrid` does the same but keeps `alwaysRegister` entity sets as individual tools. |
| `alwaysRegister` | no | Entity sets kept as individual tools in `hybrid` mode. Accepts `EntitySet` or `api:EntitySet` for lookup in the filtered discovery index. Names absent from that index fail at startup rather than silently not pinning. |
| `maxResults` | no | Cap for a `brief` search (default `25`). |
| `maxFullResults` | no | Cap for a `full` search (default `5`) — full schemas are verbose, so narrow first. |

Pins are stored by entity set name: an API-qualified lookup does not namespace tool names or limit the pin to that API. Other category-enabled definitions with the same entity set name also keep their individual tools; any resulting registration collision is rejected as described in [API config validation](#3-add-your-api-config).

### The two tools

**`search_operations(query, api?, category?, detail?, limit?)`** — catalog *and* inspect in one call. `detail: "brief"` (default) returns name, category, available operations and description; `detail: "full"` adds keys, navigation/filterable/selectable properties, per-operation method requirements, and concrete `path` examples.

Two levels rather than the more common three-tool `discover → describe → execute` split, for two reasons: the spec's own guidance is to *"offer multiple detail levels"* on the catalog tool, and it saves a round trip when the model already knows what it wants.

An empty or unmatched query returns the whole catalog rather than nothing, with `matched: false` and a `note` saying so — a dead end is worse for the model than a list it can narrow. Search is keyword-based with field weighting (exact name ≫ name prefix ≫ category ≫ description), and splits camelCase so `sub accounts` finds `Subaccounts`. Embeddings were deliberately not used: it would pull a model dependency into a package that has none.

**`execute_operation(api, entitySet, operation, path?, navProperty?, body?, headers?)`** — routes to the same `ODataClient`, method and path construction as the generated tools, including the `requiredScope` policy (the check is shared, not reimplemented; see [Operation Scopes](#operation-scopes)). The shared [tool request argument rules](#tool-request-arguments) also apply.

Because a generic executor has no per-tool schema to reject bad input, it validates routing itself and every failure names the valid options:

```
execute_operation({ api: "cis-accounts", entitySet: "Subaccounts", operation: "get" })
→ Operation "get" on Subaccounts needs a key expression in "path".
  Keys: subaccountGUID (string). Example path: ('<subaccountGUID>').
```

Unknown entity sets suggest the API that does have them; unavailable operations list what *is* available and why; `create`/`update` without a body and unknown navigation properties are rejected before the backend is touched.

### Schema resources

Discovery also registers one `odata://{api}/{entitySet}` resource per entity set in its index: only category-enabled definitions with at least one available operation are included. Navigation properties alone do not keep a definition in the index. Each resource returns the same full schema. Hosts that pre-fetch and cache resources can read a schema with no tool round-trip and no context cost until it is read — the 2026-07-28 spec added `ttlMs`/`cacheScope` hints to `resources/read` for exactly this.

### Why the tool list never changes

A tempting alternative is registering concrete tools on demand and firing `notifications/tools/list_changed`. This implementation deliberately does not, for two reasons from the spec: adding or removing tool definitions mid-conversation invalidates the model's prompt cache (the guidance is to *"route every call through a single stable meta-tool so the array never changes"*), and the 2026-07-28 revision removed protocol sessions so that `tools/list` **no longer varies per-connection**. A fixed tool surface is now the conformant design.

Interactive `ui` views are always registered and never hidden behind discovery — they are few, and they are the entry points the model should prefer.

## Programmatic API

The package root exports a `start()` function, so you can embed the server in your own entry point instead of using the CLI:

```js
// server.mjs
import { start } from 'odata-mcp-proxy';

await start(); // identical to running `odata-mcp-proxy`
```

To register extra tools or resources on every MCP session, pass `registerExtras`. It runs inside the per-session factory, after the generated entity tools, API doc resources, and config-driven UI views. It also runs for the [startup self-check](#3-add-your-api-config), so it must be safe to invoke repeatedly with different `McpServer` instances, including one that never connects to a transport. An error thrown during the self-check rejects `start()`:

```js
import { start, authorize } from 'odata-mcp-proxy';

await start({
  registerExtras(server, ctx) {
    // server: the session's McpServer
    // ctx.clientsByApi: shared ODataClient instances keyed by API name
    // ctx.apiConfig:    the loaded API config file
    // ctx.config:       the environment-derived app config
    // ctx.scopeOptions: the resolved scope-enforcement policy (pass to authorize)
    server.registerTool('My_CustomTool', { description: '...', inputSchema: {} }, async (args, extra) => {
      authorize('read', extra.authInfo?.token, ctx.scopeOptions); // same requiredScope policy
      const result = await ctx.clientsByApi['my-api'].execute('GET', 'Products', undefined, undefined, extra.authInfo?.token);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
  },
});
```

`ODataClient`, `resolveDestination`, `createMcpServer`, `registerAllTools`, `registerApiDocResources`, the scope-policy helpers `authorize` / `checkScope` (and the `ScopeOptions` type), and the config types are re-exported from the package root as well. For scope enforcement and custom-transport requirements, see [Operation Scopes](#operation-scopes).

**Migration note:** if you previously forked the bootstrap (copying the transport/session wiring and deep-importing from `odata-mcp-proxy/dist/...` to add your own tools), you can delete that entry point: call `start({ registerExtras })` for custom tools, and move interactive views into the config's `ui` section. Remaining deep `dist/` imports are supported via the package's `exports` map, but the root export is the supported surface. The former `dist/auth/xsuaa-auth.js` module has been removed; inbound authentication now uses `@arc-mcp/xsuaa-auth`.

---

## BTP Deployment (Standalone)

When working with the source repository directly (not as an npm dependency), the project includes its own `mta.yaml` for deployment to SAP BTP Cloud Foundry. The MTA provisions the required service instances (Destination, Connectivity, XSUAA) and deploys the server as a Node.js application using HTTP transport.

```bash
npm run build:btp    # Build the MTA archive
npm run deploy:btp   # Deploy to Cloud Foundry
```

For detailed deployment instructions, destination configuration, and XSUAA setup, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Configuration

The server validates core environment settings and the selected API config at startup using Zod and fails fast on invalid values. `NODE_ENV`, `CORS_ORIGIN`, and `ALLOW_UNAUTHENTICATED_HTTP` are read directly, without schema validation.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_TRANSPORT` | No | `http` | Transport mode: `http` (BTP deployment) or `stdio` (Claude Desktop) |
| `PORT` | No | `4004` | HTTP server port (only used when `MCP_TRANSPORT=http`) |
| `LOG_LEVEL` | No | `info` | Logging level: `error`, `warn`, `info`, `debug` |
| `REQUEST_TIMEOUT` | No | `60000` | HTTP request timeout in milliseconds |
| `ENABLED_API_CATEGORIES` | No | `all` | Comma-separated list of API categories to enable (see below) |
| `API_CONFIG_FILE` | No | `api-config.json` | Config file name or absolute path. A relative name is resolved against the current working directory, then the entry-script directory, then the package's bundled `dist/config/`. |
| `PUBLIC_BASE_URL` | No | CF route, then `http://localhost:<PORT>` | Public origin for OAuth discovery, protected-resource metadata, and the server callback (HTTP with XSUAA bound). Use HTTPS outside localhost; no base path, query, fragment, or credentials. Set it for a reverse proxy with a different host. Without an override, the first route in `VCAP_APPLICATION` is used; the request `Host` header is never used. |
| `CORS_ORIGIN` | No | -- | Serialized browser origin (scheme and host, plus any non-default port; no path or trailing slash). With `NODE_ENV=production` it is the sole allowed CORS origin; unset omits CORS allow-origin headers. Otherwise it is added to the [loopback-origin allow-list](#http-streamable-http), including on Cloud Foundry. The server never reflects an arbitrary origin while credentials are enabled. CORS is a browser policy, not authentication. |
| `NODE_ENV` | No | -- | `production` selects structured JSON logging; other values select pretty development logs. For HTTP CORS behavior, see `CORS_ORIGIN` above. |
| `ALLOW_UNAUTHENTICATED_HTTP` | No | -- | Explicit opt-in for unauthenticated Cloud Foundry HTTP; see the [HTTP startup policy](#http-streamable-http) before enabling it. |

> **Destination names** are configured in the active API config's `destination` field (see [API config](#3-add-your-api-config)). On BTP, credentials resolve through the bound Destination service; for local development, configure the per-destination OAuth2 env vars described in [docs/LOCAL_RUN.md](docs/LOCAL_RUN.md#local-authentication-variables).

### API Categories

Use `ENABLED_API_CATEGORIES` to restrict which tool groups are registered:

| Category | Description |
|---|---|
| `integration-content` | Integration packages, iFlows, value/message mappings, script collections, custom tags, deploy status |
| `message-processing-logs` | Message processing logs, ID mappings, idempotent repository |
| `message-stores` | Data stores, variables, number ranges, message stores, JMS brokers and queues |
| `log-files` | System log files and log file archives |
| `security-content` | Keystores, certificates, SSH keys, credentials, OAuth2 clients, secure parameters, access policies |
| `partner-directory` | Partners, string/binary parameters, alternative partners, authorized users |

Set to `all` (the default) to enable every category. Otherwise, every requested category must match an entity set in the active API config, including when using discovery. An unknown category (e.g. a typo) fails startup with a message listing the unknown and available categories, even if other requested categories are valid.

### Operation Scopes

Each entry in an entity set's `operations` is either a boolean or an object with an optional `requiredScope`:

```json
"operations": {
  "list": { "enabled": true, "requiredScope": "read" },
  "create": { "enabled": true, "requiredScope": "write" },
  "delete": { "enabled": true, "requiredScope": "admin" }
}
```

`start()` enforces `requiredScope` only when the transport authenticates callers: HTTP with an XSUAA service bound. There, `/mcp` rejects requests without a valid bearer token, and a tool call whose token lacks the scope fails with `Forbidden`. The caller's scope is matched against the fully-qualified `<xsappname>.<scope>` built from the bound XSUAA application name, so another app's `.<scope>` or an XSUAA built-in such as `uaa.user` does not satisfy a bare `<scope>`. Every configured scope is app-local, including dotted names: `orders.read` requires `<xsappname>.orders.read`, never the unqualified `orders.read`. A `scope` claim issued as a space-separated string (rather than a JSON array) is handled too.

Navigation tools (`<EntitySet>_<NavProperty>_list`) have no scope setting of their own. They enforce the `requiredScope` of the entity set's read operations: the call is allowed when the caller holds the scope of the enabled `list` or of the enabled `get` (`get` counts only when the entity set has keys). Either one suffices, and an enabled read operation without `requiredScope` leaves the navigation tool unscoped. The rule follows from the other ways to reach the same URL: the suffix `(<key>)/<NavProperty>` can also be passed as `path` to `<EntitySet>_list` or `<EntitySet>_get`, or navigation can be reached through an `execute_operation` `list`/`get` call with `navProperty`. Each of those checks its operation's scope. The navigation tool therefore grants exactly what those read paths grant, never more. When neither `list` nor a keyed `get` is enabled, no read path grants the navigation, so its registered navigation tools refuse every call with `Forbidden` while scopes are enforced.

Over stdio, or HTTP without XSUAA, there is no caller token, so `requiredScope` is not enforced and backend access is governed by the destination's own credentials. The server logs a warning at startup when an enabled operation that registers a tool declares a scope that will not be enforced. A scoped `get`/`delete` on a keyless entity set registers no tool, so it does not trigger the warning.

Interactive [UI views](#interactive-ui-views-mcp-ui) may declare their own `requiredScope`, checked under the same policy before any data source is fetched. It is **not inferred from entity-set scopes**: declare it explicitly when a view fetches scope-restricted data, or callers could render data that its entity tool would deny. Data sources do not accept an independent `requiredScope`. The template-only `ui://` resource is not gated by the view's scope; it contains `null` data rather than fetched results.

Programmatic callers of `registerAllTools` / `registerEntityTools`, `registerDiscoveryTools`, and the UI registration helpers enforce scopes by default and must provide the bound `xsappname`. Pass scope options as the final argument to `registerAllTools`, `registerEntityTools`, or `createUiToolHandler`, as fields of `registerDiscoveryTools`' options, or nested under `scopeOptions` in `registerUiTools`' options. A missing or blank app name fails registration/startup even when no tool declares a scope. `authorize` and `checkScope` also reject missing application context. Pass `{ enforceScopes: false }` to `authorize` or the registration helpers to opt out; `checkScope` always uses the enforcing policy. For custom transports, follow the authenticated-JWT precondition in the [scope-helper contract](src/tools/registry.ts). To apply the resolved policy to extras, use `ctx.scopeOptions` as shown in [Programmatic API](#programmatic-api).

---

## Available Tools

Tools are dynamically generated from entity set definitions. Each entity set produces up to five tools (`_list`, `_get`, `_create`, `_update`, `_delete`) plus navigation property tools, depending on what the OData API supports.

Read the Markdown resource `odata-mcp-proxy://api/overview` for an overview of entity sets in enabled categories, their available CRUD operations, keys, navigation properties, and filter hints. Definitions without CRUD operations remain visible so navigation-only APIs retain their guidance. The URI is fixed regardless of the configured server name; clients using the former `{serverName}://api/overview` URI must switch to this URI.

### Integration Content

| Tool | Operations |
|---|---|
| `IntegrationPackages` | list, get, create, update, delete |
| `IntegrationDesigntimeArtifacts` | list, get, create, update, delete + Resources, Configurations |
| `IntegrationRuntimeArtifacts` | list, get |
| `ValueMappingDesigntimeArtifacts` | list, get, create, update, delete + ValMapSchema |
| `MessageMappingDesigntimeArtifacts` | list, get, create, update, delete |
| `ScriptCollectionDesigntimeArtifacts` | list, get, create, update, delete |
| `CustomTagConfigurations` | list, get, create, update, delete |
| `BuildAndDeployStatus` | list, get |

### Message Processing Logs

| Tool | Operations |
|---|---|
| `MessageProcessingLogs` | list, get + Attachments, ErrorInformations, AdapterAttributes, CustomHeaderProperties, MessageStoreEntries |
| `IdMapFromId2s` | list |
| `IdempotentRepositoryEntries` | list |

### Message Stores

| Tool | Operations |
|---|---|
| `DataStoreEntries` | list, get, delete |
| `Variables` | list, get |
| `NumberRanges` | list, get |
| `MessageStoreEntries` | list, get |
| `JmsBrokers` | list, get |
| `JmsResources` | list |

### Log Files

| Tool | Operations |
|---|---|
| `LogFiles` | list, get |
| `LogFileArchives` | list, get |

### Security Content

| Tool | Operations |
|---|---|
| `KeystoreEntries` | list, get, delete |
| `CertificateResources` | list, get |
| `SSHKeyResources` | list, get |
| `UserCredentials` | list, get, create, update, delete |
| `OAuth2ClientCredentials` | list, get, create, update, delete |
| `SecureParameters` | list, get, create, update, delete |
| `CertificateUserMappings` | list, get, create, update, delete |
| `AccessPolicies` | list, get, create, update, delete + ArtifactReferences |

### Partner Directory

| Tool | Operations |
|---|---|
| `Partners` | list, get, create, update, delete |
| `StringParameters` | list, get, create, update, delete |
| `BinaryParameters` | list, get, create, update, delete |
| `AlternativePartners` | list, get, create, update, delete |
| `AuthorizedUsers` | list, get, create, update, delete |

### Tool Naming Convention

Tools follow the pattern `{EntitySet}_{operation}`:

```
IntegrationPackages_list
IntegrationPackages_get
IntegrationPackages_create
IntegrationDesigntimeArtifacts_Configurations_list
MessageProcessingLogs_ErrorInformations_list
```

### Tool Request Arguments

Generated entity tools and `execute_operation` accept a `path` **suffix**, not a full URL or an API-root path. It is appended to the configured `urlPath` (default: `entitySet`) under the API's `pathPrefix`. Omit it or use an empty string to address the collection, where the operation permits it.

A nonempty suffix must start with one of:

- `(` for an OData key expression, e.g. `('MyId')?$select=Id,Name`. Keyed paths can include further navigation or resource segments, such as `('MyId')/$value`.
- `?` for query options, e.g. `?$filter=Name eq 'test'&$top=10`.
- `/<declared-navigation-property>`, optionally with a key and further segments, e.g. `/Configurations('MyParam')/Values?$top=1`.
- `/<REST-key>` for a **single nonempty segment** that is not a declared navigation property, e.g. `/subaccountGUID?$select=guid`. Further segments such as `/subaccountGUID/more` are rejected.

Validation rejects `..`, `%2e` (case-insensitive), backslashes, and `#` **anywhere in the suffix**, including key values and query options. Control characters (U+0000–U+001F and U+007F–U+009F) and trailing spaces are also rejected. The normalized URL pathname must remain at the entity-set prefix or continue at a key (`(`) or slash (`/`) boundary; a lookalike prefix is not sufficient. Invalid paths return an `isError` tool result before any backend request. The shared validator is [src/tools/path-guard.ts](src/tools/path-guard.ts).

Navigation tools append their navigation property **before** any query string; do not include that property again in `path`. For example, `IntegrationDesigntimeArtifacts_Configurations_list` with `path: "(Id='MyFlow',Version='active')?$top=5"` requests `IntegrationDesigntimeArtifacts(Id='MyFlow',Version='active')/Configurations?$top=5`. The discovery executor does the same when `navProperty: "Configurations"` is supplied.

The optional `headers` argument is filtered case-insensitively through `ALLOWED_REQUEST_HEADERS` in [src/client/odata-client.ts](src/client/odata-client.ts), the authoritative allowlist. Use it for supported negotiation and concurrency headers, such as `Accept` and `If-Match`; all other model-supplied headers are silently dropped. Destination authentication and CSRF handling remain controlled by the SAP Cloud SDK, not the tool's headers. A supplied JSON body sets `Content-Type` to `application/json`.

### OData Query Parameters

All `_list` tools accept standard OData V2 query options:

- `$filter` -- e.g., `"Status eq 'FAILED'"`
- `$select` -- e.g., `"Id,Name,Status"`
- `$expand` -- e.g., `"Configurations"`
- `$orderby` -- e.g., `"Name asc"`
- `$top` -- e.g., `10`
- `$skip` -- e.g., `20`

### Response Bodies

Tool results are decoded from the raw response bytes:

- JSON content types (`application/json`, `*+json`) are returned parsed.
- Any other body that is valid UTF-8 is returned as text, e.g. a Groovy script from `.../Resources(...)/$value`. A leading UTF-8 BOM is preserved as U+FEFF, so re-encoding the string as UTF-8 reproduces the original bytes.
- Anything else, such as an iflow zip from `IntegrationDesigntimeArtifacts(Id='...',Version='active')/$value`, is returned losslessly as a base64 envelope:

```json
{ "contentType": "application/zip", "encoding": "base64", "size": 21605, "data": "UEsDBBQACAgI..." }
```

The `data` value can be passed unchanged as base64 content (e.g. `ArtifactContent`) to a `_create` or `_update` call, which is how an artifact is copied. For HTTP uploads, see the [request body limit](#http-streamable-http).

---

## Transport Modes

### HTTP (Streamable HTTP)

Used for BTP Cloud Foundry deployment. The server exposes an `/mcp` endpoint supporting the MCP Streamable HTTP transport with session management, plus an unauthenticated `/health` endpoint for CF health checks.

With a complete XSUAA service binding, `/mcp` requires a valid bearer token. An incomplete or malformed binding stops HTTP startup rather than disabling authentication. On Cloud Foundry (`VCAP_APPLICATION` present) the server **refuses to start** in HTTP mode without an XSUAA binding unless `ALLOW_UNAUTHENTICATED_HTTP=true` is set, since a publicly-routable, unauthenticated server would hold the destination's credentials. Only the literal value `true` opts in; local HTTP (no `VCAP_APPLICATION`) and stdio ignore this variable. Without an XSUAA binding off Cloud Foundry, HTTP is **unauthenticated** and must not be exposed publicly. For MCP-native OAuth discovery and client setup, see [Connecting MCP Clients](docs/DEPLOYMENT.md#7-connecting-mcp-clients); tool-level authorization is described in [Operation Scopes](#operation-scopes).

Outside Cloud Foundry the HTTP server binds loopback (`127.0.0.1`) and enables the Streamable HTTP transport's DNS-rebinding protection. Allowed `Host` values are exactly `127.0.0.1:<PORT>` and `localhost:<PORT>`; on port 80 their portless forms are also accepted. When an `Origin` header is supplied, it must match `http://127.0.0.1:<PORT>`, `http://localhost:<PORT>`, or the explicit `CORS_ORIGIN`. The loopback origins omit `:80` on port 80, matching browser origin serialization. These transport checks apply regardless of `NODE_ENV`; CORS response headers follow the separate [configuration policy](#configuration). Configure `CORS_ORIGIN` only for a trusted browser client.

On Cloud Foundry the server binds all interfaces (`0.0.0.0`) for the platform router and disables transport DNS-rebinding checks. Caller protection there depends on the XSUAA bearer guard; with the unauthenticated opt-in above and no XSUAA binding, that protection is absent. HTTP posture regressions are covered by [test/http-posture.test.ts](test/http-posture.test.ts) and [test/e2e-http-posture.test.ts](test/e2e-http-posture.test.ts).

Each `initialize` returns a fresh server-generated UUID in the `mcp-session-id` response header. Any ID supplied on initialization is ignored without replacing an existing session; clients must use the returned ID on subsequent requests. Sessions are stored in memory with a fixed 30-minute idle TTL, measured from initialization or the last request routed to the session, and checked once per minute. Expired sessions are removed and closed.

Non-initialize requests with an unknown session ID return HTTP 404; initialize again to obtain a new ID. `GET /mcp` and `DELETE /mcp` without a `mcp-session-id` header return HTTP 400 instead.

JSON request bodies on `/mcp` have a fixed **50 MiB** (`50mb`) limit, including base64 content and the JSON-RPC envelope, not just the raw artifact bytes. Routing is case-insensitive and accepts a trailing slash (e.g. `/MCP` and `/McP/` share this limit). When XSUAA is bound, authentication runs before body parsing, including on these alternate spellings and unmatched `/mcp/*` subpaths. An oversized MCP JSON body returns HTTP `413` with a JSON-RPC error (`code: -32600`, `id: null`) explaining the limit, rather than an HTML error page. Allowed CORS origins can read this error response.

Public and unmatched routes retain Express's default 100 KiB JSON body limit. Malformed JSON and URL-encoded parser errors retain Express's normal error responses; they are not converted to JSON-RPC errors.

Unexpected failures in the `POST`, `GET`, or `DELETE /mcp` handlers are logged without crashing the process. If the response has not started, the server returns HTTP `500` with JSON-RPC error `-32603` (`Internal server error`); otherwise it ends the response.

```bash
MCP_TRANSPORT=http PORT=4004 npm start
```

### stdio

Used for local development and direct integration with Claude Desktop. Communication happens over standard input/output streams; stdout carries only MCP messages, and all log output, including SAP Cloud SDK logs, goes to stderr.

```bash
MCP_TRANSPORT=stdio npm start
```

---

## Tech Stack

- **Runtime:** Node.js with ES Modules (see [prerequisites](#prerequisites))
- **Language:** TypeScript 5.7+
- **MCP SDK:** `@modelcontextprotocol/sdk` (resolved version in [package-lock.json](package-lock.json))
- **SAP Cloud SDK:** `@sap-cloud-sdk/connectivity` and `@sap-cloud-sdk/http-client` 4.x for destination resolution and HTTP calls
- **Validation:** Zod for configuration and input validation
- **HTTP Framework:** Express (HTTP transport only; version requirements in [package.json](package.json))
- **Logging:** Winston

---

## License

MIT
