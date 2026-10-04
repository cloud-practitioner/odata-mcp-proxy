// Unit tests for the API config schema: every config shipped with the repo
// stays valid, and malformed configs are rejected with a message that names
// the offending location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseApiConfig } from '../src/config/api-config-schema.js';
import { resolveOperation, type ApiConfig } from '../src/config/index.js';

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

test('a UI view may declare an optional requiredScope (F13)', () => {
  const config = parseApiConfig({
    server: { name: 's' },
    apis: [{ name: 'a', destination: 'DEST', entitySets: [] }],
    ui: [{ tool: 'UI_E', uri: 'ui://e', template: 'e.html', requiredScope: 'admin' }],
  }, 'cfg.json');
  assert.equal(config.ui?.[0].requiredScope, 'admin');

  // Still strict: an empty string and an unknown key are rejected.
  assert.throws(
    () => parseApiConfig({
      server: { name: 's' },
      apis: [{ name: 'a', destination: 'DEST', entitySets: [] }],
      ui: [{ tool: 'UI_E', uri: 'ui://e', template: 'e.html', requiredScope: '' }],
    }, 'cfg.json'),
    /ui\[0\]\.requiredScope/,
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

test('category filters allow repeated entity and navigation tool names outside the effective set', () => {
  const orders = { entitySet: 'Orders', category: 'sales', keys: [], operations: { list: true }, navigationProperties: [{ name: 'Items' }] };
  for (const sameApi of [true, false]) {
    const billing = [
      { ...orders, category: 'billing', navigationProperties: [] },
      { entitySet: 'Orders_Items', category: 'billing', keys: [], operations: { list: true } },
    ];
    const config = {
      server: { name: 's' },
      apis: sameApi
        ? [{ name: 'a', destination: 'DEST', entitySets: [orders, ...billing] }]
        : [
            { name: 'a', destination: 'DEST', entitySets: [orders] },
            { name: 'b', destination: 'DEST', entitySets: billing },
          ],
    };
    for (const category of ['sales', 'billing']) {
      assert.doesNotThrow(() => parseApiConfig(config, 'cfg.json', [category]));
    }
    assert.throws(() => parseApiConfig(config, 'cfg.json', ['sales', 'billing']), /duplicate tool name "Orders_list"/);
    assert.match(errorFor(config), /duplicate tool name "Orders_Items_list"/);
    assert.doesNotThrow(() => parseApiConfig({ ...config, discovery: { mode: 'search' } }, 'cfg.json', ['sales']));
  }
});

test('get and delete tool collisions respect key gating in both operation representations', () => {
  for (const enabled of [true, { enabled: true }]) {
    const keyless = { entitySet: 'Orders', keys: [], operations: { get: enabled, delete: enabled } };
    const keyed = { ...keyless, keys: [{ name: 'Id', type: 'string' }] };
    const config = { server: { name: 's' }, apis: [{ name: 'a', destination: 'DEST', entitySets: [keyless, keyed] }] };
    assert.doesNotThrow(() => parseApiConfig(config, 'cfg.json'));
    config.apis[0].entitySets = [keyed, keyed];
    assert.match(errorFor(config), /duplicate tool name "Orders_get"/);
    assert.match(errorFor(config), /duplicate tool name "Orders_delete"/);
  }
});

test('keyless list, create and update collisions are detected in both operation representations', () => {
  for (const operation of ['list', 'create', 'update']) {
    for (const enabled of [true, { enabled: true }]) {
      const entity = { entitySet: 'Orders', keys: [], operations: { [operation]: enabled } };
      const config = { server: { name: 's' }, apis: [{ name: 'a', destination: 'DEST', entitySets: [entity, entity] }] };
      assert.ok(errorFor(config).includes(`duplicate tool name "Orders_${operation}"`));
      config.apis[0].entitySets[0] = { ...entity, operations: { [operation]: { enabled: false } } };
      assert.doesNotThrow(() => parseApiConfig(config, 'cfg.json'));
    }
  }
});

test('discovery resources ignore inactive definitions, including navigation-only and key-gated ones', () => {
  for (const mode of ['search', 'hybrid']) {
    for (const operations of [{}, { list: false }, { list: { enabled: false } }, { get: true, delete: { enabled: true } }]) {
      const config = {
        server: { name: 's' },
        apis: [{ name: 'a', destination: 'DEST', entitySets: [
          { entitySet: 'Orders', keys: [], operations, navigationProperties: [{ name: 'Items' }] },
          { entitySet: 'Orders', keys: [], operations: { list: true } },
        ] }],
        discovery: { mode, alwaysRegister: ['Orders'] },
      };
      assert.doesNotThrow(() => parseApiConfig(config, 'cfg.json'));
    }
    const active = { entitySet: 'Orders', keys: [], operations: { list: true } };
    assert.throws(() => parseApiConfig({
      server: { name: 's' },
      apis: [{ name: 'a', destination: 'DEST', entitySets: [active, active] }],
      discovery: { mode },
    }, 'cfg.json'), /duplicate resource URI "odata:\/\/a\/Orders"/);
  }
});

test('search collapses cross-api entity tools but hybrid preserves genuine pinned collisions', () => {
  const entity = { entitySet: 'Orders', keys: [], operations: { list: true } };
  const config = {
    server: { name: 's' },
    apis: ['a', 'b'].map((name) => ({ name, destination: 'DEST', entitySets: [entity] })),
  };
  assert.doesNotThrow(() => parseApiConfig({ ...config, discovery: { mode: 'search' } }, 'cfg.json'));
  for (const pin of ['Orders', 'a:Orders']) {
    assert.throws(() => parseApiConfig({ ...config, discovery: { mode: 'hybrid', alwaysRegister: [pin] } }, 'cfg.json'), /duplicate tool name "Orders_list"/);
  }
});

test('hybrid pins resolve only through category-enabled definitions with available operations', () => {
  const config: ApiConfig = {
    server: { name: 's', version: '1' },
    apis: [
      { name: 'a', destination: 'DEST', entitySets: [{ entitySet: 'Orders', description: '', category: 'sales', keys: [], operations: { list: true } }] },
      { name: 'b', destination: 'DEST', entitySets: [{ entitySet: 'Orders', description: '', category: 'billing', keys: [], operations: { list: true } }] },
    ],
    discovery: { mode: 'hybrid', alwaysRegister: ['a:Orders'] },
    ui: [{ tool: 'Orders_list', uri: 'ui://orders', template: 't.html' }],
  };
  assert.doesNotThrow(() => parseApiConfig(config, 'cfg.json', ['billing']));
  config.apis[0].entitySets[0].operations = { get: true, delete: true };
  assert.doesNotThrow(() => parseApiConfig(config, 'cfg.json'));
  for (const pin of ['Orders', 'b:Orders']) {
    config.discovery!.alwaysRegister = [pin];
    assert.throws(() => parseApiConfig(config, 'cfg.json', ['billing']), /duplicate tool name "Orders_list"/);
  }
});

test('hybrid registers navigation tools on siblings sharing a pinned entity name', () => {
  const config = {
    server: { name: 's' },
    apis: [{ name: 'a', destination: 'DEST', entitySets: [
      { entitySet: 'Orders', keys: [], operations: {}, navigationProperties: [{ name: 'Items' }] },
      { entitySet: 'Orders', keys: [], operations: { list: true } },
    ] }],
    ui: [{ tool: 'Orders_Items_list', uri: 'ui://items', template: 't.html' }],
  };
  assert.doesNotThrow(() => parseApiConfig({ ...config, discovery: { mode: 'search' } }, 'cfg.json'));
  assert.throws(() => parseApiConfig({ ...config, discovery: { mode: 'hybrid', alwaysRegister: ['Orders'] } }, 'cfg.json'), /duplicate tool name "Orders_Items_list"/);
});

test('UI collisions with discovery and overview remain fatal with no enabled entities', () => {
  for (const mode of ['search', 'hybrid']) {
    for (const tool of ['search_operations', 'execute_operation']) {
      assert.throws(() => parseApiConfig({
        server: { name: 's' }, apis: [], discovery: { mode },
        ui: [{ tool, uri: 'ui://x', template: 't.html' }],
      }, 'cfg.json', []), new RegExp(`duplicate tool name "${tool}"`));
    }
  }
  assert.throws(() => parseApiConfig({
    server: { name: 's' }, apis: [],
    ui: [{ tool: 'UI_X', uri: 'odata-mcp-proxy://api/overview', template: 't.html' }],
  }, 'cfg.json', []), /duplicate resource URI "odata-mcp-proxy:\/\/api\/overview"/);
  assert.doesNotThrow(() => parseApiConfig({
    server: { name: 's' }, apis: [],
    ui: [{ tool: 'UI_X', uri: 's://api/overview', template: 't.html' }],
  }, 'cfg.json', []));
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
