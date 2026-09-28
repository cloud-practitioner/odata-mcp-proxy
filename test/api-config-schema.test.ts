// Unit tests for the API config schema: every config shipped with the repo
// stays valid, and malformed configs are rejected with a message that names
// the offending location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseApiConfig } from '../src/config/api-config-schema.js';
import { resolveOperation } from '../src/config/index.js';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const shippedConfigs = [
  ...readdirSync(join(rootDir, 'src', 'config')).filter((f) => f.endsWith('.json')).map((f) => join(rootDir, 'src', 'config', f)),
  ...readdirSync(join(rootDir, 'test', 'fixtures')).filter((f) => f.endsWith('.json')).map((f) => join(rootDir, 'test', 'fixtures', f)),
];

for (const file of shippedConfigs) {
  test(`shipped config ${file.slice(rootDir.length + 1)} is valid`, () => {
    assert.doesNotThrow(() => parseApiConfig(JSON.parse(readFileSync(file, 'utf8')), file));
  });
}

/** A minimal valid config whose single entity set's operations are `operations`. */
function withOperations(operations: unknown): unknown {
  return {
    server: { name: 's', version: '1', description: '' },
    apis: [{
      name: 'a',
      destination: 'DEST',
      pathPrefix: '/api',
      entitySets: [{ entitySet: 'E', description: 'e', category: 'c', keys: [{ name: 'Id', type: 'string' }], operations }],
    }],
  };
}

/** The error message produced for an invalid config. */
function errorFor(raw: unknown): string {
  try {
    parseApiConfig(raw, 'cfg.json');
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail('expected the config to be rejected');
}

const OPS = 'apis[0].entitySets[0].operations';

test('update accepts PATCH, PUT and MERGE, and resolves the method', () => {
  for (const method of ['PATCH', 'PUT', 'MERGE'] as const) {
    const config = parseApiConfig(withOperations({ update: { enabled: true, requiredScope: 'write', method } }), 'cfg.json');
    const resolved = resolveOperation(config.apis[0].entitySets[0].operations.update);
    assert.deepEqual(resolved, { enabled: true, requiredScope: 'write', method });
  }
});

test('an update without a method resolves to no method (callers default to PATCH)', () => {
  const config = parseApiConfig(withOperations({ update: { enabled: true } }), 'cfg.json');
  assert.equal(resolveOperation(config.apis[0].entitySets[0].operations.update).method, undefined);
});

test('an unknown update method is rejected', () => {
  assert.match(
    errorFor(withOperations({ update: { enabled: true, method: 'POST' } })),
    /apis\[0\]\.entitySets\[0\]\.operations\.update\.method: Invalid enum value\. Expected 'PATCH' \| 'PUT' \| 'MERGE', received 'POST'/,
  );
});

test('method is only accepted on update', () => {
  assert.ok(errorFor(withOperations({ get: { enabled: true, method: 'PUT' } }))
    .includes(`${OPS}.get: Unrecognized key(s) in object: 'method'`));
});

test('a misspelled operation option is rejected', () => {
  assert.ok(errorFor(withOperations({ list: { enabled: true, requiredscope: 'read' } }))
    .includes(`${OPS}.list: Unrecognized key(s) in object: 'requiredscope'`));
});

test('a misspelled operation name is rejected', () => {
  assert.ok(errorFor(withOperations({ updates: true }))
    .includes(`${OPS}: Unrecognized key(s) in object: 'updates'`));
});

test('an operation of the wrong type is rejected', () => {
  assert.ok(errorFor(withOperations({ list: 'yes' }))
    .includes(`${OPS}.list: Expected boolean or object, received string`));
});

test('the object form requires enabled', () => {
  assert.ok(errorFor(withOperations({ update: { method: 'PUT' } }))
    .includes(`${OPS}.update.enabled: Required`));
});

test('omitted operations are valid and disabled', () => {
  const config = parseApiConfig(withOperations({ list: true }), 'cfg.json');
  assert.deepEqual(resolveOperation(config.apis[0].entitySets[0].operations.delete), { enabled: false });
});

test('entity set, key and navigation property shapes are checked', () => {
  const base = withOperations({ list: true }) as { apis: Array<{ entitySets: Array<Record<string, unknown>> }> };
  const entity = base.apis[0].entitySets[0];
  entity.urlpath = 'X';
  entity.keys = [{ name: 'Id', type: 'guid' }];
  entity.navigationProperties = [{ name: 'Items', description: 'items', isCollection: 'yes' }];

  const message = errorFor(base);
  assert.ok(message.startsWith('API config validation failed for cfg.json:'), message);
  assert.ok(message.includes("apis[0].entitySets[0]: Unrecognized key(s) in object: 'urlpath'"), message);
  assert.ok(message.includes('apis[0].entitySets[0].keys[0].type: Invalid enum value'), message);
  assert.ok(message.includes('apis[0].entitySets[0].navigationProperties[0].isCollection: Expected boolean, received string'), message);
});

test('api-level and top-level misspellings are rejected', () => {
  const base = withOperations({ list: true }) as Record<string, unknown> & { apis: Array<Record<string, unknown>> };
  base.apis[0].csrfprotected = false;
  base.dicovery = { mode: 'search' };

  const message = errorFor(base);
  assert.ok(message.includes("apis[0]: Unrecognized key(s) in object: 'csrfprotected'"), message);
  assert.ok(message.includes("(root): Unrecognized key(s) in object: 'dicovery'"), message);
});
