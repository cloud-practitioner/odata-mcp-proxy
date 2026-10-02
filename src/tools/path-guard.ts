// =============================================================================
// Request-path hardening shared by the static registry tools and the discovery
// executor.
//
// Both forward a model-supplied `path` suffix onto an entity set. Without
// validation a caller can slip `..` / `%2e%2e` segments into the path: the SDK
// resolves the URL with `new URL()`, which normalises those segments, so a
// caller holding one tool's scope could reach any path on the destination host
// with that tool's HTTP method — crossing into entity sets requiring a higher
// scope, a disabled category, a disabled operation, or even outside the API's
// pathPrefix. (F3)
//
// The same builder also inserts a navigation segment *before* any query string
// so `$filter`/`$top` keep applying to the navigation collection instead of
// producing a malformed `Entity('k')?$x=y/Nav`. (F19)
//
// One module, used by both call sites, so the two paths cannot drift.
// =============================================================================

/** Raised when a model-supplied path fails validation. */
export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathValidationError';
  }
}

/** Substrings that must never appear in a model-supplied path. (F3) */
const FORBIDDEN_TOKENS: Array<{ token: string; label: string }> = [
  { token: '..', label: '".." path segments' },
  { token: '%2e', label: 'encoded dots "%2e"' },
  { token: '\\', label: 'backslashes' },
  { token: '#', label: 'fragments "#"' },
];

export interface BuildPathOptions {
  /** URL path segment of the entity set (`urlPath ?? entitySet`). */
  urlPath: string;
  /** The API's path prefix, e.g. "/api/v1". */
  pathPrefix: string;
  /** Model-supplied OData path suffix (keys, query options, navigation). */
  path?: string;
  /** Navigation property to append, if this is a nav tool/call. */
  navProperty?: string;
  /** Navigation property names the entity set declares. */
  navProperties: string[];
}

/**
 * Validate the model-supplied path and build the full relative path that is
 * handed to the OData client. Throws {@link PathValidationError} on any unsafe
 * path.
 */
export function buildEntityPath(opts: BuildPathOptions): string {
  const { urlPath, navProperty, navProperties } = opts;
  const pathPrefix = opts.pathPrefix ?? '';
  const raw = opts.path ?? '';

  if (raw) {
    const lower = raw.toLowerCase();
    for (const { token, label } of FORBIDDEN_TOKENS) {
      if (lower.includes(token)) {
        throw new PathValidationError(`Path may not contain ${label}.`);
      }
    }

    // A valid OData suffix is a key expression "(…)", a query string "?…", or a
    // navigation into a declared property "/Nav…". Anything else is an attempt
    // to address a different resource. (F3)
    const first = raw[0];
    if (first !== '(' && first !== '?' && first !== '/') {
      throw new PathValidationError(
        'Path must start with "(" (key expression), "?" (query options) or ' +
          '"/<navigation property>".',
      );
    }
    if (first === '/') {
      const segment = raw.slice(1).split(/[/?(]/)[0];
      if (!navProperties.includes(segment)) {
        throw new PathValidationError(
          navProperties.length > 0
            ? `Path navigates to "/${segment}", which is not a declared navigation ` +
                `property. Available: ${navProperties.join(', ')}.`
            : 'Path may not start with "/": this entity set declares no navigation properties.',
        );
      }
    }
  }

  // Insert the navigation segment before any query string so $filter/$top still
  // bind to the navigation collection. (F19)
  let suffix = raw;
  if (navProperty) {
    const queryIndex = raw.indexOf('?');
    suffix =
      queryIndex >= 0
        ? `${raw.slice(0, queryIndex)}/${navProperty}${raw.slice(queryIndex)}`
        : `${raw}/${navProperty}`;
  }

  const fullPath = `${urlPath}${suffix}`;

  // Defense in depth: after URL normalisation the resolved path must still live
  // under this entity set's prefix. The forbidden-token checks above already
  // reject the known escapes; this catches anything they miss. (F3)
  const resolved = new URL(`${pathPrefix}/${fullPath}`, 'http://odata.invalid');
  const expectedPrefix = `${pathPrefix}/${urlPath}`;
  if (!resolved.pathname.startsWith(expectedPrefix)) {
    throw new PathValidationError(
      `Path resolves outside the "${urlPath}" entity set and was rejected.`,
    );
  }

  return fullPath;
}
