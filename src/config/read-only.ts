import type { EntitySetDefinition } from '../tools/registry.js';

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
