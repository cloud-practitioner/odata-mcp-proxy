import winston from 'winston';
import { setGlobalTransports } from '@sap-cloud-sdk/util';

const { combine, timestamp, printf, colorize, json, errors } = winston.format;

/**
 * Custom format for local development: [timestamp] [level] message
 * Metadata (if any) is appended as a JSON string.
 */
const devFormat = combine(
  errors({ stack: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  colorize(),
  printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    const msg = stack ?? message;
    return `[${timestamp}] [${level}] ${msg}${metaStr}`;
  }),
);

/**
 * JSON format for production (Cloud Foundry / BTP).
 * Structured JSON is easier to ingest by log aggregation services.
 */
const prodFormat = combine(
  errors({ stack: true }),
  timestamp(),
  json(),
);

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function getLogLevel(): string {
  return process.env.LOG_LEVEL ?? 'info';
}

/**
 * Over stdio, stdout carries the MCP JSON-RPC stream, so every log level must
 * go to stderr; a log line on stdout corrupts the protocol.
 */
function stderrLevels(): string[] {
  return process.env.MCP_TRANSPORT === 'stdio' ? Object.keys(winston.config.npm.levels) : [];
}

function createLogger(level?: string): winston.Logger {
  return winston.createLogger({
    level: level ?? getLogLevel(),
    format: isProduction() ? prodFormat : devFormat,
    transports: [
      new winston.transports.Console({ stderrLevels: stderrLevels() }),
    ],
  });
}

/**
 * The application-wide Winston logger instance.
 *
 * Usage:
 * ```typescript
 * import { logger } from '../utils/logger.js';
 * logger.info('Server started', { port: 4004 });
 * logger.error('Failed to connect', { error: err.message });
 * ```
 */
export let logger: winston.Logger = createLogger();

/**
 * Reinitialize the logger with a specific log level.
 * This replaces the module-level `logger` instance so that all subsequent
 * imports / references pick up the new configuration.
 *
 * @param level - Winston log level (e.g. 'error', 'warn', 'info', 'debug')
 */
export function initLogger(level: string): void {
  logger = createLogger(level);
}

/**
 * Point the SAP Cloud SDK's independent Winston logger at stderr.
 *
 * The SDK logs through its own logger whose default Console transport writes to
 * stdout. Over stdio that stream carries the MCP JSON-RPC protocol, so a single
 * SDK log line — e.g. the warning emitted when a CSRF token fetch fails —
 * corrupts the channel and breaks `JSON.parse` in a strict MCP stdio client.
 * Setting the SDK's global transports to a stderr-only Console keeps every SDK
 * log line off stdout. Call this once, early, whenever stdout must stay pure
 * JSON-RPC (i.e. in stdio transport mode).
 */
export function routeSdkLoggingToStderr(): void {
  setGlobalTransports(
    new winston.transports.Console({ stderrLevels: Object.keys(winston.config.npm.levels) }),
  );
}
