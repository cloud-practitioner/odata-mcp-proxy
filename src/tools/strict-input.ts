import { z, type ZodRawShape } from 'zod';

/**
 * Build a tool input schema that rejects unknown top-level arguments.
 *
 * The MCP SDK wraps a raw shape in a default (non-strict) `z.object`, which
 * silently drops unknown keys even though the advertised JSON schema says
 * `additionalProperties: false`. A dropped key such as `$top` then looks like a
 * working call whose option was honoured. A strict object makes the runtime
 * match the advertised schema: the call fails with a tool error that names the
 * unrecognised key.
 */
export function strictInput<T extends ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}
