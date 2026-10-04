// F24: the package root must export the scope policy (authorize, checkScope,
// ScopeOptions) so `registerExtras` consumers can gate their own tools with the
// same policy instead of silently bypassing `requiredScope`, and the
// ExtrasContext must carry the resolved scope options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as root from '../src/index.js';
import { authorize as registryAuthorize, checkScope as registryCheckScope } from '../src/tools/registry.js';
import type { ExtrasContext, ScopeOptions } from '../src/index.js';

test('the package root re-exports authorize and checkScope (F24)', () => {
  assert.equal(typeof root.authorize, 'function');
  assert.equal(typeof root.checkScope, 'function');
  // The same implementations the generated tools use, not reimplementations.
  assert.equal(root.authorize, registryAuthorize);
  assert.equal(root.checkScope, registryCheckScope);
});

test('the re-exported authorize applies the same scope policy (F24)', () => {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = `${part({ alg: 'none' })}.${part({ scope: ['app!t1.read'] })}.sig`;

  // enforcing (default): a token lacking the scope is refused.
  assert.throws(() => root.authorize('write', jwt, { xsappname: 'app!t1' }),
    /Forbidden: operation requires scope 'write'/);
  // opt-out: extras over stdio / unauthenticated HTTP let the call through.
  assert.doesNotThrow(() => root.authorize('write', jwt, { enforceScopes: false }));
});

test('ExtrasContext carries the resolved scopeOptions (F24)', () => {
  // Compile-time guard: the field must exist and be a ScopeOptions.
  const scopeOptions: ScopeOptions = { enforceScopes: true, xsappname: 'app!t1' };
  const ctx: Pick<ExtrasContext, 'scopeOptions'> = { scopeOptions };
  assert.deepEqual(ctx.scopeOptions, { enforceScopes: true, xsappname: 'app!t1' });
});
