import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntitySetDefinition } from '../tools/registry.js';
import { resolveOperation } from '../config/index.js';
import { logger } from '../utils/logger.js';

/** CRUD operations in display order. */
const OPERATION_ORDER = ['list', 'get', 'create', 'update', 'delete'] as const;

/**
 * Operations that address a single entity and therefore need a key expression
 * in the path: an entity set with no keys cannot expose them, so they must not
 * be advertised as available (mirrors the discovery index key-gating).
 */
const KEYED_OPERATIONS = new Set(['get', 'delete']);

/** Whether a comma-separated category filter admits this definition. */
function isCategoryEnabled(category: string, enabledCategories: string[]): boolean {
  const isAll = enabledCategories.length === 1 && enabledCategories[0] === 'all';
  return isAll || enabledCategories.includes(category);
}

/**
 * Return the operations that are actually available for an entity set: enabled
 * (resolving the boolean | object form) and, for key-addressed operations,
 * backed by at least one key property.
 */
function availableOperations(def: EntitySetDefinition): string[] {
  const hasKeys = def.keys.length > 0;
  return OPERATION_ORDER.filter((op) => {
    if (!resolveOperation(def.operations[op]).enabled) return false;
    if (KEYED_OPERATIONS.has(op) && !hasKeys) return false;
    return true;
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive the human-friendly label for a category slug.
 *
 * "integration-content"  ->  "Integration Content"
 * "message-processing-logs"  ->  "Message Processing Logs"
 */
function formatCategoryLabel(category: string): string {
  if (!category) return 'Uncategorized';
  return category
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Return a comma-separated list of the operations that are available for an
 * entity set (e.g. "list, get, create") — enabled, key-gated, category-filtered.
 */
function formatOperations(def: EntitySetDefinition): string {
  return availableOperations(def).join(', ');
}

// ─── Markdown Generation ─────────────────────────────────────────────────────

/**
 * Build the full Markdown document that summarises every registered entity set.
 *
 * Entity sets are grouped by their `category` field and listed in the order
 * they appear in the definitions array.
 */
function buildApiOverviewMarkdown(
  definitions: EntitySetDefinition[],
  serverName: string,
  enabledCategories: string[],
): string {
  const visible = definitions.filter(
    (def) => isCategoryEnabled(def.category, enabledCategories),
  );

  // Group definitions by category while preserving insertion order.
  const grouped = new Map<string, EntitySetDefinition[]>();
  for (const def of visible) {
    let group = grouped.get(def.category);
    if (!group) {
      group = [];
      grouped.set(def.category, group);
    }
    group.push(def);
  }

  const lines: string[] = [];

  lines.push(`# ${serverName} — API Overview`);
  lines.push('');
  lines.push(
    `This document lists every OData entity set exposed by ${serverName}, ` +
    'grouped by API category. Each entity set maps to one or more MCP tools ' +
    '(named `{EntitySet}_{operation}`).',
  );
  lines.push('');

  for (const [category, defs] of grouped) {
    lines.push(`## ${formatCategoryLabel(category)}`);
    lines.push('');

    for (const def of defs) {
      lines.push(`### ${def.entitySet}`);
      lines.push('');
      lines.push(`**Description:** ${def.description}`);
      lines.push('');
      lines.push(`**Operations:** ${formatOperations(def)}`);
      lines.push('');

      // Key properties
      const keyList = def.keys.map((k) => `\`${k.name}\` (${k.type})`).join(', ');
      lines.push(`**Key properties:** ${keyList}`);
      lines.push('');

      // Navigation properties (only if present)
      if (def.navigationProperties && def.navigationProperties.length > 0) {
        lines.push('**Navigation properties:**');
        lines.push('');
        for (const nav of def.navigationProperties) {
          const collectionTag = nav.isCollection === undefined ? '' : ` (${nav.isCollection ? 'collection' : 'single'})`;
          lines.push(`- \`${nav.name}\`${collectionTag} — ${nav.description ?? nav.name}`);
        }
        lines.push('');
      }

      // Filterable properties (only if present)
      if (def.filterableProperties && def.filterableProperties.length > 0) {
        const filterList = def.filterableProperties.map((p) => `\`${p}\``).join(', ');
        lines.push(`**Filterable properties:** ${filterList}`);
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ─── Resource Registration ───────────────────────────────────────────────────

/**
 * Register MCP resources that expose API documentation to LLM clients.
 *
 * Currently registers a single static resource:
 *
 * - **{serverName}-api-overview** (`odata-mcp-proxy://api/overview`) — a Markdown
 *   summary of all available entity sets, their operations, keys, and
 *   navigation properties.
 *
 * @param server            The MCP server instance to register resources on.
 * @param definitions       The full list of entity set definitions to document.
 * @param serverName        Server name used for the resource title and name.
 * @param enabledCategories Category filter; only enabled categories are listed.
 */
export function registerApiDocResources(
  server: McpServer,
  definitions: EntitySetDefinition[],
  serverName: string,
  enabledCategories: string[] = ['all'],
): void {
  const markdown = buildApiOverviewMarkdown(definitions, serverName, enabledCategories);

  // The resource URI needs a syntactically valid scheme. A server name is not:
  // `new URL()` lowercases it (so uppercase names become unreadable) and
  // rejects an underscore outright. Use a fixed, valid scheme instead.
  const overviewUri = 'odata-mcp-proxy://api/overview';

  server.resource(
    `${serverName}-api-overview`,
    overviewUri,
    {
      description:
        `Markdown overview of all ${serverName} OData entity sets — their descriptions, ` +
        'supported operations, key properties, navigation properties, and filterable fields.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: markdown,
        },
      ],
    }),
  );

  logger.info('API documentation resources registered', {
    resourceCount: 1,
    entitySetCount: definitions.length,
  });
}
