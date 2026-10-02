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

test('update accepts PATCH and PUT, and resolves the method', () => {
  for (const method of ['PATCH', 'PUT'] as const) {
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
    /apis\[0\]\.entitySets\[0\]\.operations\.update\.method: Invalid enum value\. Expected 'PATCH' \| 'PUT', received 'POST'/,
  );
});

test('a minimal config omitting optional fields loads with their defaults', () => {
  const config = parseApiConfig({
    server: { name: 's' },
    apis: [
      { name: 'a', destination: 'DEST', entitySets: [] },
      {
        destination: 'DEST',
        entitySets: [{
          entitySet: 'E',
          keys: [{ name: 'Id', type: 'string' }],
          operations: { list: true },
          navigationProperties: [{ name: 'Items' }],
        }],
      },
    ],
    ui: [{ tool: 'UI_E', uri: 'ui://e', template: 'e.html' }],
  }, 'cfg.json');
  const packageVersion = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).version;
  assert.deepEqual(config.server, { name: 's', version: packageVersion });
  assert.deepEqual(config.apis.map((api) => api.name), ['a', 'api1']);
  assert.equal(config.apis[1].pathPrefix, undefined);
  assert.deepEqual(config.apis[1].entitySets[0], {
    entitySet: 'E',
    description: 'E',
    category: '',
    keys: [{ name: 'Id', type: 'string' }],
    operations: { list: true },
    navigationProperties: [{ name: 'Items' }],
  });
  assert.equal(config.ui?.[0].description, undefined);
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

// ─── Duplicate api names (F11) ───────────────────────────────────────────────

test('a duplicate apis[].name is rejected by the schema', () => {
  const config = {
    server: { name: 's' },
    apis: [
      { name: 'cpi', destination: 'DEST_A', entitySets: [] },
      { name: 'cpi', destination: 'DEST_B', entitySets: [] },
    ],
  };
  assert.ok(errorFor(config).includes('apis[1].name: duplicate api name "cpi" (already used by apis[0])'), errorFor(config));
});

test('a default api name colliding with an explicit one is rejected', () => {
  // The second api omits `name`, so it defaults to "api1"; the first names
  // itself "api1" explicitly — the transform fills the default, then the
  // refine catches the collision.
  const config = {
    server: { name: 's' },
    apis: [
      { name: 'api1', destination: 'DEST_A', entitySets: [] },
      { destination: 'DEST_B', entitySets: [] },
    ],
  };
  assert.ok(errorFor(config).includes('apis[1].name: duplicate api name "api1"'), errorFor(config));
});

test('distinct api names are accepted', () => {
  assert.doesNotThrow(() => parseApiConfig({
    server: { name: 's' },
    apis: [
      { name: 'cpi', destination: 'DEST_A', entitySets: [] },
      { name: 'btp', destination: 'DEST_B', entitySets: [] },
    ],
  }, 'cfg.json'));
});

// ─── Duplicate generated tool names / resource URIs (F10) ────────────────────

/** A config with two entity sets, each with the given name, both list-enabled. */
function withEntitySets(names: string[]): unknown {
  return {
    server: { name: 's' },
    apis: [{
      name: 'a',
      destination: 'DEST',
      entitySets: names.map((entitySet) => ({
        entitySet,
        keys: [{ name: 'Id', type: 'string' }],
        operations: { list: true },
      })),
    }],
  };
}

test('two entity sets with the same name are rejected (duplicate tool name)', () => {
  const message = errorFor(withEntitySets(['Orders', 'Orders']));
  assert.ok(message.includes('duplicate tool name "Orders_list"'), message);
});

test('two entity sets with the same name in different apis are rejected', () => {
  const config = {
    server: { name: 's' },
    apis: [
      { name: 'a', destination: 'DEST_A', entitySets: [{ entitySet: 'Orders', keys: [{ name: 'Id', type: 'string' }], operations: { list: true } }] },
      { name: 'b', destination: 'DEST_B', entitySets: [{ entitySet: 'Orders', keys: [{ name: 'Id', type: 'string' }], operations: { list: true } }] },
    ],
  };
  assert.ok(errorFor(config).includes('duplicate tool name "Orders_list"'), errorFor(config));
});

test('distinct entity set names are accepted', () => {
  assert.doesNotThrow(() => parseApiConfig(withEntitySets(['Orders', 'Invoices']), 'cfg.json'));
});

test('two UI views with the same uri are rejected (duplicate resource URI)', () => {
  const config = {
    server: { name: 's' },
    apis: [{ name: 'a', destination: 'DEST', entitySets: [] }],
    ui: [
      { tool: 'UI_One', uri: 'ui://dash', template: 'a.html' },
      { tool: 'UI_Two', uri: 'ui://dash', template: 'b.html' },
    ],
  };
  assert.ok(errorFor(config).includes('duplicate resource URI "ui://dash"'), errorFor(config));
});

test('a UI view tool colliding with a generated entity tool is rejected', () => {
  const config = {
    server: { name: 's' },
    apis: [{ name: 'a', destination: 'DEST', entitySets: [{ entitySet: 'Orders', keys: [{ name: 'Id', type: 'string' }], operations: { list: true } }] }],
    ui: [{ tool: 'Orders_list', uri: 'ui://dash', template: 'a.html' }],
  };
  assert.ok(errorFor(config).includes('duplicate tool name "Orders_list"'), errorFor(config));
});
