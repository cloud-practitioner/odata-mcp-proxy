// =============================================================================
// Registration plan — the tool names and resource URIs a config will generate.
//
// MCP's `server.tool()` / `registerResource()` throw "... already registered"
// when the same name is registered twice, but that throw happens inside the
// per-session factory (on the first client connect over HTTP, or at launch
// over stdio) rather than at startup. Enumerating the names the config will
// generate lets `parseApiConfig` reject a colliding config up front, with a
// message that names the clash instead of a late crash.
//
// Kept free of runtime dependencies (types only) so it can be unit-tested and
// so it never pulls the config loader into a cycle.
// =============================================================================

import type { ApiConfig, ApiDefinition } from './index.js';

type EntitySet = ApiDefinition['entitySets'][number];

/** Minimal `resolveOperation`: we only need whether an operation is enabled. */
function isEnabled(op: unknown): boolean {
  if (op === true) return true;
  if (op && typeof op === 'object') return (op as { enabled?: boolean }).enabled === true;
  return false;
}

function operationToolNames(def: EntitySet): string[] {
  const es = def.entitySet;
  const keyed = def.keys.length > 0;
  const names: string[] = [];
  if (isEnabled(def.operations.list)) names.push(`${es}_list`);
  if (isEnabled(def.operations.get) && keyed) names.push(`${es}_get`);
  if (isEnabled(def.operations.create)) names.push(`${es}_create`);
  if (isEnabled(def.operations.update)) names.push(`${es}_update`);
  if (isEnabled(def.operations.delete) && keyed) names.push(`${es}_delete`);
  return names;
}

/**
 * Entity sets kept as individual tools under hybrid discovery — mirrors the
 * `alwaysRegister` resolution in `start()` (accepts "EntitySet" or
 * "api:EntitySet").
 */
function resolvePinned(apiConfig: ApiConfig, apis: ApiDefinition[]): Set<string> {
  const pinned = new Set<string>();
  if (apiConfig.discovery?.mode !== 'hybrid') return pinned;
  for (const name of apiConfig.discovery.alwaysRegister ?? []) {
    const [left, right] = name.includes(':') ? name.split(':', 2) : [undefined, name];
    for (const api of apis) {
      for (const def of api.entitySets) {
        if (operationToolNames(def).length > 0 && def.entitySet === right && (left === undefined || api.name === left)) {
          pinned.add(def.entitySet);
        }
      }
    }
  }
  return pinned;
}

export function collectRegistrationNames(
  apiConfig: ApiConfig,
  enabledCategories: string[] = ['all'],
): { tools: string[]; resources: string[] } {
  const tools: string[] = [];
  const resources: string[] = [];
  const isAll = enabledCategories.length === 1 && enabledCategories[0] === 'all';
  const apis = apiConfig.apis.map((api) => ({
    ...api,
    entitySets: api.entitySets.filter((def) => isAll || enabledCategories.includes(def.category)),
  }));
  const discovery = apiConfig.discovery;
  const pinned = discovery ? resolvePinned(apiConfig, apis) : undefined;

  for (const api of apis) {
    for (const def of api.entitySets) {
      const operations = operationToolNames(def);
      const keepEntityTools = !discovery || (discovery.mode === 'hybrid' && pinned!.has(def.entitySet));
      if (keepEntityTools) {
        tools.push(...operations);
        for (const nav of def.navigationProperties ?? []) tools.push(`${def.entitySet}_${nav.name}_list`);
      }
      if (discovery && operations.length > 0) resources.push(`odata://${api.name}/${def.entitySet}`);
    }
  }

  if (discovery) tools.push('search_operations', 'execute_operation');

  // API documentation overview resource (always registered).
  resources.push('odata-mcp-proxy://api/overview');

  for (const view of apiConfig.ui ?? []) {
    tools.push(view.tool);
    resources.push(view.uri);
  }

  return { tools, resources };
}

function duplicates(items: string[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) dups.add(item);
    else seen.add(item);
  }
  return [...dups];
}

/**
 * Duplicate generated tool names and resource URIs for a config. A non-empty
 * result means the config would crash the per-session factory on first use.
 */
export function findDuplicateRegistrations(
  apiConfig: ApiConfig,
  enabledCategories: string[] = ['all'],
): { tools: string[]; resources: string[] } {
  const { tools, resources } = collectRegistrationNames(apiConfig, enabledCategories);
  return { tools: duplicates(tools), resources: duplicates(resources) };
}
