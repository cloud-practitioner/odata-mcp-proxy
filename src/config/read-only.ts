import type { EntitySetDefinition } from '../tools/registry.js';

/** Accepted `MCP_READ_ONLY` values, for the startup error message. */
export const READ_ONLY_ACCEPTED_VALUES = 'true, false, 1, 0 (case-insensitive); unset or empty means off';

/**
 * Parse the `MCP_READ_ONLY` environment variable.
 *
 * `true`/`1` (case-insensitive) turn read-only mode on; `false`/`0` and an
 * unset or empty value leave it off. Any other value returns `undefined`, so
 * the caller can refuse to start: a misspelt value must never silently grant
 * write access to an operator who meant read-only.
 */
export function parseReadOnly(raw: string | undefined): boolean | undefined {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return true;
  return undefined;
}

/**
 * Read-only mode (MCP_READ_ONLY=true): disable create, update and delete on every
 * entity set. Both the per-entity tools and the discovery tools read the operations
 * from these definitions, so no write tool is registered or offered. The ODataClient
 * refuses writes as well, for code paths that do not go through the definitions.
 */
export function applyReadOnly(apis: Array<{ entitySets: EntitySetDefinition[] }>): void {
  for (const api of apis) {
    for (const set of api.entitySets) {
      set.operations.create = false;
      set.operations.update = false;
      set.operations.delete = false;
    }
  }
}
