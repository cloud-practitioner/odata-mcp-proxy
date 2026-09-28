// =============================================================================
// Zod schema for the static API configuration (api-config.json and friends).
//
// The config drives every tool, so a typo must fail at startup rather than
// silently disable an operation or fall back to a default method. Objects are
// strict: an unknown or misspelled key (e.g. `requiredscope`) is an error.
//
// Kept free of side effects so it can be unit-tested without loading the
// environment or a config file.
// =============================================================================

import { createRequire } from 'node:module';
import { z } from 'zod';
import type { ApiConfig } from './index.js';

/** This package's version, the server version when the config omits one. */
const PACKAGE_VERSION: string = createRequire(import.meta.url)('../../package.json').version;

/** HTTP methods an `update` operation may be configured to send. */
export const UPDATE_METHODS = ['PATCH', 'PUT'] as const;
export type UpdateMethod = (typeof UPDATE_METHODS)[number];

const nonEmpty = z.string().min(1);

/** `true`/`false`, or `{ enabled, requiredScope? }`. */
const operationSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean(),
    requiredScope: nonEmpty.optional(),
  }).strict(),
]);

/** Like `operationSchema`, plus the HTTP method used for the update. */
const updateOperationSchema = z.union([
  z.boolean(),
  z.object({
    enabled: z.boolean(),
    requiredScope: nonEmpty.optional(),
    method: z.enum(UPDATE_METHODS).optional(),
  }).strict(),
]);

const keyPropertySchema = z.object({
  name: nonEmpty,
  type: z.enum(['string', 'number']),
}).strict();

const navigationPropertySchema = z.object({
  name: nonEmpty,
  description: z.string().optional(),
  isCollection: z.boolean().optional(),
}).strict();

const entitySetSchema = z.object({
  entitySet: nonEmpty,
  urlPath: nonEmpty.optional(),
  description: z.string().optional(),
  category: z.string().optional(),
  keys: z.array(keyPropertySchema),
  // An omitted operation is disabled, exactly as `false`.
  operations: z.object({
    list: operationSchema.optional(),
    get: operationSchema.optional(),
    create: operationSchema.optional(),
    update: updateOperationSchema.optional(),
    delete: operationSchema.optional(),
  }).strict(),
  filterableProperties: z.array(z.string()).optional(),
  selectableProperties: z.array(z.string()).optional(),
  navigationProperties: z.array(navigationPropertySchema).optional(),
}).strict().transform((entity) => ({
  ...entity,
  description: entity.description ?? entity.entitySet,
  category: entity.category ?? '',
}));

const apiDefinitionSchema = z.object({
  name: nonEmpty.optional(),
  destination: nonEmpty,
  pathPrefix: z.string().optional(),
  csrfProtected: z.boolean().optional(),
  entitySets: z.array(entitySetSchema),
}).strict();

// ─── UI views ────────────────────────────────────────────────────────────────
//
// Structure only. Cross-field rules (default vs required, min/max on numbers,
// known `api` names) are checked by the UI registration, which reports them
// with the view's tool name.

const uiInputSchema = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().optional(),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
}).strict();

const uiPaginationSchema = z.object({
  strategy: z.enum(['offset', 'skiptop']),
  pageSize: z.number().int().positive().optional(),
  maxItems: z.number().int().positive().optional(),
  itemsPath: z.string().optional(),
  totalPath: z.string().optional(),
}).strict();

const uiDataSourceSchema = z.object({
  api: nonEmpty,
  path: z.string(),
  optional: z.boolean().optional(),
  paginate: uiPaginationSchema.optional(),
  select: z.array(z.string()).optional(),
}).strict();

const uiViewSchema = z.object({
  tool: nonEmpty,
  description: z.string().optional(),
  uri: nonEmpty,
  template: nonEmpty,
  inputs: z.record(uiInputSchema).optional(),
  data: z.record(uiDataSourceSchema).optional(),
  partials: z.record(z.string()).optional(),
  frameSize: z.tuple([z.string(), z.string()]).optional(),
}).strict();

const discoverySchema = z.object({
  mode: z.enum(['search', 'hybrid']),
  alwaysRegister: z.array(nonEmpty).optional(),
  maxResults: z.number().int().positive().optional(),
  maxFullResults: z.number().int().positive().optional(),
}).strict();

export const apiConfigSchema = z.object({
  server: z.object({
    name: nonEmpty,
    version: z.string().default(PACKAGE_VERSION),
    description: z.string().optional(),
  }).strict(),
  apis: z.array(apiDefinitionSchema).transform((apis) =>
    apis.map((api, i) => ({ ...api, name: api.name ?? `apis[${i}]` })),
  ),
  ui: z.array(uiViewSchema).optional(),
  discovery: discoverySchema.optional(),
}).strict();

// Compile-time guard: a config accepted by the schema must satisfy the
// hand-written `ApiConfig` interface, so the two cannot drift apart silently.
type Assignable<T extends ApiConfig> = T;
export type ParsedApiConfig = Assignable<z.infer<typeof apiConfigSchema>>;

/** Render a Zod issue path as `apis[0].entitySets[3].operations.update`. */
function formatPath(path: (string | number)[]): string {
  return path
    .map((segment, i) => (typeof segment === 'number' ? `[${segment}]` : i === 0 ? segment : `.${segment}`))
    .join('') || '(root)';
}

/**
 * Flatten issues for reporting. An operation is `boolean | object`, and Zod
 * reports any failure inside such a union as a bare "Invalid input"; descend
 * into the branch whose top-level type matched so the message names the real
 * problem (e.g. a bad `method` or an unrecognized key).
 */
function collectIssues(issues: z.ZodIssue[]): z.ZodIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code !== 'invalid_union') return [issue];
    const typeMatched = issue.unionErrors.filter((branch) =>
      !branch.issues.some((i) => i.code === 'invalid_type' && i.path.length === issue.path.length),
    );
    if (typeMatched.length === 1) return collectIssues(typeMatched[0].issues);
    if (typeMatched.length === 0) {
      // No branch accepted the value's type: say which types would have been.
      const typeIssues = issue.unionErrors
        .flatMap((branch) => branch.issues)
        .filter((i): i is Extract<z.ZodIssue, { code: 'invalid_type' }> => i.code === 'invalid_type' && i.path.length === issue.path.length);
      const expected = [...new Set(typeIssues.map((i) => i.expected))].join(' or ');
      return [{ ...issue, message: `Expected ${expected}, received ${typeIssues[0]?.received ?? 'unknown'}` }];
    }
    return [issue];
  });
}

/**
 * Validate a parsed API config document.
 *
 * @param raw    - The JSON-parsed file content.
 * @param source - File path, used in the error message.
 * @throws {Error} listing every issue with its location in the document.
 */
export function parseApiConfig(raw: unknown, source: string): ApiConfig {
  const result = apiConfigSchema.safeParse(raw);
  if (result.success) return result.data;

  const issues = collectIssues(result.error.issues)
    .map((issue) => `  - ${formatPath(issue.path)}: ${issue.message}`)
    .join('\n');
  throw new Error(`API config validation failed for ${source}:\n${issues}`);
}
