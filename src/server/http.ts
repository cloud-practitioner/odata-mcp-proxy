// =============================================================================
// HTTP Server
//
// Express application with JSON body parsing, CORS, request logging, and a
// health check — plus inbound authentication via `@arc-mcp/xsuaa-auth`:
// the MCP-native XSUAA OAuth proxy (RFC 8414 discovery + RFC 7591 stateless
// dynamic client registration + an HMAC-signed `/oauth/callback` proxy) and a
// XSUAA bearer verifier. The `/mcp` protocol routes
// (POST/GET/DELETE) are registered by the entry point (src/index.ts) after
// transport initialisation; they sit behind the bearer guard mounted here.
//
// Auth-only model: the verifier extracts no MCP-level scopes
// (`scopesSupported: []`, no `requiredScopes`) — a valid XSUAA token is
// sufficient at the transport, and the per-tool `requiredScope` policy
// (src/tools/registry.ts) gates individual tools against the caller JWT the
// verifier attaches at `req.auth.token`. When no XSUAA service is bound (local
// / stdio dev) `/mcp` is left open and a warning is logged.
//
// Security notes (fork hardening on top of PR #5):
//   - F17 token logging: the request logger redacts the query string, so auth
//     codes / refresh tokens that ride in a URL never reach the logs.
//   - F17 Host-header poisoning: the OAuth discovery/metadata URLs are built
//     from a configured public base URL (`PUBLIC_BASE_URL` env var) or the CF
//     route (`VCAP_APPLICATION`), never from the request `Host` header.
// =============================================================================

import {
  type Logger as AuthLogger,
  type XsuaaCredentials,
  loadXsuaaCredentials,
  resolveAppUrl,
} from '@arc-mcp/xsuaa-auth';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { logger } from '../utils/logger.js';
import { setupXsuaaAuth } from './oauth.js';

/**
 * Environment variable naming the public base URL this server advertises in its
 * OAuth discovery / protected-resource metadata. Set it when the app is reached
 * through a reverse proxy on a different host than the CF route. It must be an
 * HTTP(S) origin without a base path, query, fragment, or credentials. When
 * unset, {@link resolveAppUrl} falls back to the `VCAP_APPLICATION` route and
 * then a `localhost` default — in no case the request `Host` header (F17).
 */
export const PUBLIC_URL_ENV_VAR = 'PUBLIC_BASE_URL';

/**
 * Redact the query string from a request URL before it is logged. OAuth
 * endpoints receive auth codes and refresh tokens in the query string
 * (`?code=…`, `?refresh_token=…`); logging `req.originalUrl` verbatim would
 * leak them into the (BTP-visible) application log (F17). The path is kept for
 * diagnostics; the query is collapsed to a fixed marker.
 */
export function redactUrlForLog(originalUrl: string): string {
  const q = originalUrl.indexOf('?');
  if (q === -1) return originalUrl;
  return `${originalUrl.slice(0, q)}?<redacted>`;
}

// Adapt the winston logger to the `@arc-mcp/xsuaa-auth` structural Logger.
// Both use `(message, data)` argument order, so this just forwards.
const authLogger: AuthLogger = {
  debug: (message, data) => logger.debug(message, data),
  info: (message, data) => logger.info(message, data),
  warn: (message, data) => logger.warn(message, data),
  error: (message, data) => logger.error(message, data),
};

/**
 * Load the bound XSUAA credentials, or `undefined` when none is bound (local /
 * stdio dev — `/mcp` is then left open). An invalid binding rejects startup.
 */
function loadXsuaa(): XsuaaCredentials | undefined {
  if (process.env.VCAP_SERVICES === undefined) return undefined;
  const services = JSON.parse(process.env.VCAP_SERVICES);
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw new Error('VCAP_SERVICES must be an object');
  }
  if (services.xsuaa === undefined || (Array.isArray(services.xsuaa) && services.xsuaa.length === 0)) {
    return undefined;
  }
  if (!Array.isArray(services.xsuaa)) throw new Error('Invalid XSUAA binding');
  return loadXsuaaCredentials();
}

/**
 * Whether a complete XSUAA binding is present. When `true`, the HTTP transport
 * mounts the bearer guard on `/mcp` (every request carries a verified caller
 * JWT), so per-tool `requiredScope` enforcement is meaningful. The entry point
 * uses this to decide `enforceScopes`; it must agree with {@link createHttpServer}'s
 * own `loadXsuaa()` decision so scope enforcement is on exactly when `/mcp` is
 * guarded.
 */
export function isXsuaaConfigured(): boolean {
  return loadXsuaa() !== undefined;
}

/**
 * Creates an Express application pre-configured with body parsing, CORS, request
 * logging, a health check, and — when an XSUAA service is bound — the MCP-native
 * OAuth proxy plus a bearer guard on `/mcp` (via `@arc-mcp/xsuaa-auth`).
 *
 * @param port - TCP port; used for the OAuth-metadata URL fallback and logging.
 */
export function createHttpServer(port: number): Express {
  const app = express();

  // ── Body parsing ────────────────────────────────────────────────────────────
  app.use(express.json());
  // OAuth token / registration endpoints receive application/x-www-form-urlencoded bodies.
  app.use(express.urlencoded({ extended: false }));

  // ── CORS ──────────────────────────────────────────────────────────────────────
  const isProduction = process.env.NODE_ENV === 'production';
  const corsOrigin = process.env.CORS_ORIGIN;
  app.use(
    cors({
      origin: isProduction ? (corsOrigin ?? false) : true,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'mcp-session-id',
        'mcp-protocol-version',
        'last-event-id',
      ],
      exposedHeaders: ['mcp-session-id'],
      credentials: true,
    }),
  );

  // ── Request logging ───────────────────────────────────────────────────────────
  // The URL is redacted (F17): OAuth endpoints carry auth codes / refresh tokens
  // in the query string, and logging them verbatim leaks credentials into the
  // application log. Keep the path for diagnostics; drop the query string.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    const safeUrl = redactUrlForLog(req.originalUrl);
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info(`${req.method} ${safeUrl} ${res.statusCode} - ${duration}ms`, {
        method: req.method,
        url: safeUrl,
        statusCode: res.statusCode,
        duration,
      });
    });
    next();
  });

  // ── Health check (always unauthenticated) ──────────────────────────────────────
  const credentials = loadXsuaa();
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      oauth: credentials !== undefined,
    });
  });

  // ── Inbound auth: XSUAA OAuth proxy + bearer guard on /mcp ──────────────────────
  // The metadata URLs are resolved from a configured public base URL (or the CF
  // route), never the request Host header (F17 Host-poisoning of the cacheable
  // discovery document).
  let bearer;
  if (credentials) {
    const appUrl = new URL(resolveAppUrl(process.env, { port, publicUrlEnvVar: PUBLIC_URL_ENV_VAR }));
    if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.pathname !== '/' ||
        appUrl.search || appUrl.hash || appUrl.username || appUrl.password) {
      throw new Error('PUBLIC_BASE_URL must be an HTTP(S) origin without a base path');
    }
    bearer = setupXsuaaAuth(app, credentials, appUrl.origin, authLogger);
  }
  if (bearer) {
    app.use('/mcp', bearer);
    logger.info('XSUAA OAuth proxy enabled — /mcp requires a valid bearer token');
  } else {
    logger.warn(
      'XSUAA not configured — /mcp is UNAUTHENTICATED (local / stdio dev). Do not expose publicly.',
    );
  }

  // The MCP protocol endpoints (POST/GET/DELETE /mcp) are registered by the entry
  // point after transport initialisation; they run behind the guard mounted above.

  logger.debug('Express application created', { port, oauth: credentials !== undefined });
  return app;
}

/**
 * Starts the Express server on the given port.
 *
 * @param app  - Application returned by {@link createHttpServer}
 * @param port - TCP port to listen on
 */
export function startHttpServer(app: Express, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info(`HTTP server listening on port ${port}`);
      resolve();
    });
    server.on('error', (err: Error) => {
      logger.error(`Failed to start HTTP server on port ${port}`, { error: err.message });
      reject(err);
    });
  });
}
