// =============================================================================
// MCP Server — Programmatic Entry Point
//
// Exports `start(options?)`, which wires together configuration, destination
// resolution, OData clients, MCP server + tool registration, and the chosen
// transport (HTTP or stdio). Running this file directly (`node dist/index.js`)
// calls `start()` with no options, preserving the historic CLI behavior.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config, apiConfig, apiConfigDir, resolveOperation, type Config, type ApiConfig, type ApiDefinition } from './config/index.js';
import { initLogger, logger, routeSdkLoggingToStderr } from './utils/logger.js';
import { resolveDestination } from './client/destination-service.js';
import { ODataClient } from './client/odata-client.js';
import { createMcpServer } from './server/mcp-server.js';
import { SessionStore } from './server/sessions.js';
import { registerAllTools, findUnknownCategories } from './tools/registry.js';
import { registerApiDocResources } from './resources/index.js';
import { XsuaaAuth } from './auth/xsuaa-auth.js';

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Context passed to {@link StartOptions.registerExtras} for each MCP server
 * instance, exposing the shared building blocks of the running server.
 */
export interface ExtrasContext {
  /** Shared ODataClient instances keyed by API name (the `name` field in the config). */
  clientsByApi: Record<string, ODataClient>;
  /** The loaded API configuration (server identity, APIs, optional UI views). */
  apiConfig: ApiConfig;
  /** The environment-derived application configuration. */
  config: Config;
}

export interface StartOptions {
  /**
   * Called inside the per-session factory — after the generated entity tools,
   * API doc resources, and config-driven UI views are registered — so
   * consumers can add their own tools/resources to every session without
   * forking the bootstrap. Also called for the unconnected startup probe;
   * the hook must be safe to invoke for multiple server instances.
   */
  registerExtras?: (server: McpServer, ctx: ExtrasContext) => void;
}

// Re-exports for programmatic consumers (avoids deep dist/ imports).
export { ODataClient } from './client/odata-client.js';
export { resolveDestination } from './client/destination-service.js';
export { createMcpServer } from './server/mcp-server.js';
export { registerAllTools } from './tools/registry.js';
export { registerApiDocResources } from './resources/index.js';
export type {
  Config, ApiConfig, ApiDefinition,
  UiViewDefinition, UiInputDefinition, UiDataSourceDefinition, UiPaginationDefinition,
  DiscoveryDefinition,
} from './config/index.js';
export type { EntitySetDefinition } from './tools/registry.js';

/**
 * Bootstrap and run the MCP server: create the shared OData clients, build
 * the per-session factory, and start the configured transport (HTTP or stdio).
 *
 * With no options this behaves exactly like the CLI (`odata-mcp-proxy` /
 * `node dist/index.js`).
 */
export async function start(options: StartOptions = {}): Promise<void> {
  // ── 1. Initialize logger with configured level ────────────────────────────

  initLogger(config.logLevel);

  // Over stdio, stdout is the MCP JSON-RPC channel. The SAP Cloud SDK logs
  // through its own Winston logger whose default transport writes to stdout,
  // so redirect it to stderr before any OData/CSRF call can emit a log line.
  if (config.mcpTransport === 'stdio') {
    routeSdkLoggingToStderr();
  }
  logger.info(`Starting ${apiConfig.server.name}`, {
    transport: config.mcpTransport,
    port: config.mcpTransport === 'http' ? config.port : 'N/A',
    logLevel: config.logLevel,
    enabledCategories: config.enabledApiCategories,
  });

  // ── 2. Create one OData client per API (singletons — own OAuth token caching)
  //
  // Destinations are resolved lazily on the first request. The SDK caches
  // destinations and tokens internally, so subsequent calls are fast.

  interface ODataClientEntry {
    apiDef: ApiDefinition;
    client: ODataClient;
  }

  const odataClients: ODataClientEntry[] = apiConfig.apis.map((apiDef) => {
    const getDestination = (jwt?: string) => resolveDestination(apiDef.destination, jwt);

    const client = new ODataClient(
      getDestination,
      apiDef.pathPrefix,
      config.requestTimeout,
      apiDef.csrfProtected ?? true,
    );

    logger.info('OData client created', {
      apiName: apiDef.name,
      destination: apiDef.destination,
      pathPrefix: apiDef.pathPrefix,
      timeout: config.requestTimeout,
    });

    return { apiDef, client };
  });

  const allEntitySets = apiConfig.apis.flatMap((api) => api.entitySets);
  const clientsByApi = Object.fromEntries(
    odataClients.map(({ apiDef, client }) => [apiDef.name, client]),
  );

  // Fail fast on an ENABLED_API_CATEGORIES typo: a requested category that
  // matches no entity set otherwise registers nothing, and tools/list then
  // returns an empty list (or discovery reports a misleading error) with no
  // hint that the filter was the cause.
  const unknownCategories = findUnknownCategories(config.enabledApiCategories, allEntitySets);
  if (unknownCategories.length > 0) {
    const available = [...new Set(allEntitySets.map((d) => d.category).filter(Boolean))];
    throw new Error(
      `ENABLED_API_CATEGORIES references categor${unknownCategories.length > 1 ? 'ies' : 'y'} ` +
      `matching no entity set: ${unknownCategories.join(', ')}. ` +
      `Available categories: ${available.join(', ') || '(none defined)'}.`,
    );
  }

  logger.info('OData clients ready', {
    apis: apiConfig.apis.map((a) => a.name),
    totalDefinitions: allEntitySets.length,
    enabledCategories: config.enabledApiCategories,
  });

  // The UI module (and its @mcp-ui/server dependency) is loaded lazily — only
  // when the config actually declares UI views.
  const uiViews = apiConfig.ui ?? [];
  const registerUiTools = uiViews.length > 0
    ? (await import('./ui/register.js')).registerUiTools
    : undefined;

  // ── Progressive discovery (opt-in) ──────────────────────────────────────────
  //
  // Without a `discovery` block every entity operation stays its own tool.
  // With one, the entity tools collapse into two meta-tools; `hybrid` keeps
  // the named entity sets registered so hot paths skip the discovery hop.
  const discovery = apiConfig.discovery;
  type DiscoveryModule = typeof import('./tools/discovery.js');
  let discoverySetup:
    | {
        index: ReturnType<DiscoveryModule['buildIndex']>;
        pinned: string[];
        pinnedSet: Set<string>;
        register: DiscoveryModule['registerDiscoveryTools'];
      }
    | undefined;

  if (discovery) {
    const { buildIndex, registerDiscoveryTools } = await import('./tools/discovery.js');
    const index = buildIndex(
      odataClients.map(({ apiDef, client }) => ({
        name: apiDef.name,
        client,
        entitySets: apiDef.entitySets,
      })),
      config.enabledApiCategories,
    );

    // `alwaysRegister` accepts "EntitySet" or "api:EntitySet".
    const requested = discovery.mode === 'hybrid' ? (discovery.alwaysRegister ?? []) : [];
    const pinnedSet = new Set<string>();
    const unknown: string[] = [];
    for (const name of requested) {
      const [left, right] = name.includes(':') ? name.split(':', 2) : [undefined, name];
      const hit = index.find(
        (e) => e.definition.entitySet === right && (left === undefined || e.api === left),
      );
      if (hit) pinnedSet.add(hit.definition.entitySet);
      else unknown.push(name);
    }
    if (unknown.length > 0) {
      // Fail loudly at startup rather than silently not pinning.
      throw new Error(
        `discovery.alwaysRegister references unknown entity set(s): ${unknown.join(', ')}. ` +
        `Available: ${index.map((e) => `${e.api}:${e.definition.entitySet}`).join(', ')}`,
      );
    }

    discoverySetup = { index, pinned: [...pinnedSet], pinnedSet, register: registerDiscoveryTools };
    logger.info('Progressive discovery enabled', {
      mode: discovery.mode,
      entitySets: index.length,
      pinned: discoverySetup.pinned,
    });
  }

  const extrasContext: ExtrasContext = { clientsByApi, apiConfig, config };

  // ── Scope policy ────────────────────────────────────────────────────────────
  //
  // `requiredScope` is checked against the caller's JWT, which only exists
  // when the transport authenticates callers: HTTP with XSUAA bound, where
  // requireAuth() rejects requests without a valid bearer token. Over stdio,
  // or HTTP without XSUAA, there is no caller token, so enforcing would reject
  // every scoped call; backend access is governed by the destination
  // credentials instead.
  const xsuaa = config.mcpTransport === 'http' ? new XsuaaAuth() : undefined;
  const enforceScopes = xsuaa?.isConfigured() ?? false;

  // Navigation tools need no separate term: they enforce the requiredScope of
  // their parent's enabled list/get, which this check already counts.
  const allCategories =
    config.enabledApiCategories.length === 1 && config.enabledApiCategories[0] === 'all';
  const declaresScopes = allEntitySets
    .filter((def) => allCategories || config.enabledApiCategories.includes(def.category))
    .some((def) =>
      Object.values(def.operations).some((op) => {
        const resolved = resolveOperation(op);
        return resolved.enabled && Boolean(resolved.requiredScope);
      }),
    );
  if (declaresScopes && !enforceScopes) {
    const reason = config.mcpTransport === 'stdio' ? 'stdio transport' : 'XSUAA not bound';
    logger.warn(
      `requiredScope is not enforced: no XSUAA-authenticated caller (${reason}). ` +
      'Backend access is governed by the destination credentials.',
    );
  }

  // ── 3. Session factory ──────────────────────────────────────────────────────
  //
  // Each HTTP session (or the single stdio session) gets its own McpServer
  // instance. McpServer.connect() can only be called once per instance, so
  // re-using a singleton across sessions causes "Server already initialized"
  // errors on reconnect.
  //
  // ODataClient instances are shared — they own their OAuth token caches.

  function createMcpSession(): McpServer {
    const server = createMcpServer(apiConfig.server.name, apiConfig.server.version);

    for (const { apiDef, client } of odataClients) {
      registerAllTools(
        server,
        client,
        apiDef.entitySets,
        config.enabledApiCategories,
        discoverySetup?.pinnedSet,
        { enforceScopes },
      );
    }

    if (discoverySetup && discovery) {
      discoverySetup.register(server, {
        discovery,
        index: discoverySetup.index,
        pinned: discoverySetup.pinned,
        enforceScopes,
      });
    }

    registerApiDocResources(server, allEntitySets, apiConfig.server.name, config.enabledApiCategories);

    registerUiTools?.(server, { views: uiViews, clientsByApi, baseDir: apiConfigDir });

    options.registerExtras?.(server, extrasContext);

    return server;
  }

  // ── Startup self-check ──────────────────────────────────────────────────────
  //
  // Registration must succeed before HTTP can report healthy or stdio connects.
  // Closing an unconnected probe leaves the shared ODataClients untouched.
  const probeSession = createMcpSession();
  await probeSession.close().catch(() => { /* not connected to a transport */ });

  // ── 4. Start the chosen transport ───────────────────────────────────────────

  if (config.mcpTransport === 'http') {
    // ------------------------------------------------------------------------
    // HTTP transport — Streamable HTTP over Express
    // ------------------------------------------------------------------------
    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );
    const { createHttpServer, startHttpServer, asyncHandler } = await import(
      './server/http.js'
    );

    const app = createHttpServer(config.port, xsuaa!);

    // Active sessions (sessionId -> transport + server) for stateful mode.
    type Session = {
      transport: InstanceType<typeof StreamableHTTPServerTransport>;
      server: McpServer;
    };
    const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
    const sessions = new SessionStore<Session>(
      SESSION_IDLE_TTL_MS,
      (s) => s.server.close(),
    );
    // Sweep at the TTL cadence, capped so eviction stays reasonably prompt.
    sessions.startSweeping(Math.min(SESSION_IDLE_TTL_MS, 60_000));

    // Handler for POST /mcp — initialization and JSON-RPC requests. Each MCP
    // handler is wrapped with asyncHandler so a throw returns 500 rather than
    // becoming an unhandled rejection that crashes the process.
    app.post('/mcp', asyncHandler(async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const body = req.body as { method?: string } | Array<{ method?: string }> | undefined;
      const isInitRequest = Array.isArray(body)
        ? body.some((m) => m?.method === 'initialize')
        : body?.method === 'initialize';

      // Non-initialize requests: route to existing session or 404.
      if (!isInitRequest) {
        if (sessionId && sessions.has(sessionId)) {
          const { transport } = sessions.get(sessionId)!;
          await transport.handleRequest(req, res, req.body);
          return;
        }

        // A non-initialize request with a missing/unknown session ID means the
        // session is gone (server restarted, session expired, client has a stale
        // ID). Return 404 so the client knows to start fresh.
        logger.debug('POST /mcp — session not found', {
          sessionIdHeader: sessionId ?? '(none)',
          method: Array.isArray(body) ? body.map((m) => m?.method).join(',') : (body?.method ?? '(none)'),
          activeSessions: sessions.size,
        });
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
        return;
      }

      // This is an initialize request.
      //
      // Ignore client-supplied IDs on initialize so a caller cannot replace
      // another session by re-initializing with its ID. Each handshake gets
      // a fresh server-generated ID; existing sessions are left untouched.
      const assignedSessionId = randomUUID();

      const server = createMcpSession();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => assignedSessionId,
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport, server });
          logger.debug('MCP session initialized', { sessionId: id });
        },
      });

      // Clean up when the transport closes.
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          sessions.delete(sid);
          logger.debug('MCP session closed', { sessionId: sid });
        }
      };

      // Connect the fresh MCP server to this transport.
      await server.connect(transport);

      // Handle the initial request (which will be the initialization handshake).
      await transport.handleRequest(req, res, req.body);
    }));

    // Handler for GET /mcp — SSE stream for server-to-client notifications
    app.get('/mcp', asyncHandler(async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId === undefined) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Missing or invalid mcp-session-id header.',
        });
        return;
      }

      if (!sessions.has(sessionId)) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
        return;
      }

      const { transport } = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
    }));

    // Handler for DELETE /mcp — session termination
    app.delete('/mcp', asyncHandler(async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId === undefined) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Missing or invalid mcp-session-id header.',
        });
        return;
      }

      if (!sessions.has(sessionId)) {
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
        return;
      }

      const { transport } = sessions.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
    }));

    // Start listening
    await startHttpServer(app, config.port);

    logger.info(`${apiConfig.server.name} running on HTTP port ${config.port}`, {
      transport: 'http',
      port: config.port,
      healthCheck: `http://localhost:${config.port}/health`,
      mcpEndpoint: `http://localhost:${config.port}/mcp`,
    });

    // ── 5. Graceful shutdown (HTTP) ─────────────────────────────────────────

    const shutdown = async (signal: string): Promise<void> => {
      logger.info(`Received ${signal}, shutting down gracefully...`);

      sessions.stopSweeping();
      try {
        await Promise.all(sessions.values().map(({ server }) => server.close()));
        logger.info('All MCP sessions closed');
      } catch (error) {
        logger.error('Error during shutdown', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } else {
    // ------------------------------------------------------------------------
    // Stdio transport — single server instance, no session management needed
    // ------------------------------------------------------------------------
    const { StdioServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/stdio.js'
    );

    const server = createMcpSession();
    const transport = new StdioServerTransport();

    await server.connect(transport);

    logger.info(`${apiConfig.server.name} running on stdio transport`, {
      transport: 'stdio',
    });

    // ── 5. Graceful shutdown (stdio) ────────────────────────────────────────

    const shutdown = async (signal: string): Promise<void> => {
      logger.info(`Received ${signal}, shutting down gracefully...`);

      try {
        await server.close();
        logger.info('MCP server closed');
      } catch (error) {
        logger.error('Error during shutdown', {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  }
}

// ─── Direct execution (`node dist/index.js`) ─────────────────────────────────
//
// Importing this module programmatically must NOT start the server; running
// the file directly must keep behaving like the historic entry point.

function isRunDirectly(): boolean {
  const entryScript = process.argv[1];
  if (!entryScript) return false;
  try {
    return (
      import.meta.url === pathToFileURL(entryScript).href ||
      import.meta.url === pathToFileURL(realpathSync(entryScript)).href
    );
  } catch {
    return false;
  }
}

if (isRunDirectly()) {
  await start();
}
