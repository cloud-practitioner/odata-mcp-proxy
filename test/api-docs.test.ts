// Regression tests for the API-overview resource (F15):
//
// - the "Operations:" line lists only operations that are truly enabled
//   (object-form `{ enabled: false }` counts as disabled), key-gated
//   (get/delete need a keyed entity set), and in an enabled category;
// - entity sets in a disabled category are omitted entirely;
// - the resource URI is a syntactically valid scheme even when the server
//   name contains uppercase letters or an underscore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerApiDocResources } from '../src/resources/api-docs.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntitySetDefinition } from '../src/tools/registry.js';

type ResourceHandler = (uri: URL) => Promise<{ contents: Array<{ uri: string; text: string }> }>;

interface Captured {
  name: string;
  uri: string;
  handler: ResourceHandler;
}

/** A stub McpServer that records the single resource registration. */
function captureRegistration(
  definitions: EntitySetDefinition[],
  serverName: string,
  enabledCategories: string[],
): Captured {
  let captured: Captured | undefined;
  const server = {
    resource(name: string, uri: string, _meta: unknown, handler: ResourceHandler) {
      captured = { name, uri, handler };
    },
  } as unknown as McpServer;

  registerApiDocResources(server, definitions, serverName, enabledCategories);
  assert.ok(captured, 'a resource must be registered');
  return captured;
}

async function renderMarkdown(captured: Captured): Promise<string> {
  const result = await captured.handler(new URL(captured.uri));
  return result.contents[0].text;
}

function def(partial: Partial<EntitySetDefinition> & { entitySet: string }): EntitySetDefinition {
  return {
    description: 'desc',
    category: 'general',
    keys: [],
    operations: {},
    ...partial,
  } as EntitySetDefinition;
}

/** Pull the "Operations:" line text for a given entity set out of the markdown. */
function operationsLine(markdown: string, entitySet: string): string | undefined {
  const lines = markdown.split('\n');
  const header = lines.findIndex((l) => l === `### ${entitySet}`);
  if (header === -1) return undefined;
  const opLine = lines.slice(header).find((l) => l.startsWith('**Operations:**'));
  return opLine?.replace('**Operations:**', '').trim();
}

test('overview lists only enabled, key-gated, category-filtered operations', async () => {
  const definitions: EntitySetDefinition[] = [
    // Keyed set: object-form create is disabled, so it must not appear.
    def({
      entitySet: 'IntegrationRuntimeArtifacts',
      category: 'integration-content',
      keys: [{ name: 'Id', type: 'string' }],
      operations: {
        list: true,
        get: true,
        create: { enabled: false },
        update: { enabled: true, requiredScope: 'write' },
        delete: { enabled: false },
      },
    }),
    // Keyless set: get/delete are key-gated away even though "enabled".
    def({
      entitySet: 'ServiceEndpoints',
      category: 'integration-content',
      keys: [],
      operations: { list: true, get: true, create: false, update: false, delete: true },
    }),
    // Entity set in a category that is NOT enabled: omitted entirely.
    def({
      entitySet: 'SecretStuff',
      category: 'security-content',
      keys: [{ name: 'Id', type: 'string' }],
      operations: { list: true, get: true },
    }),
  ];

  const captured = captureRegistration(definitions, 'cpi', ['integration-content']);
  const markdown = await renderMarkdown(captured);

  assert.equal(operationsLine(markdown, 'IntegrationRuntimeArtifacts'), 'list, get, update');
  assert.equal(operationsLine(markdown, 'ServiceEndpoints'), 'list');
  // The disabled category is not documented at all.
  assert.equal(operationsLine(markdown, 'SecretStuff'), undefined);
  assert.ok(!markdown.includes('Secret'), 'disabled-category entity set must be omitted');
});

test('resource URI is a valid scheme for server names with uppercase letters or underscores', async () => {
  for (const serverName of ['CPI', 'btp_admin', 'My_Odata_Server']) {
    const captured = captureRegistration(
      [def({ entitySet: 'Things', operations: { list: true } })],
      serverName,
      ['all'],
    );
    // new URL() must accept the registered URI (uppercase / underscore server
    // names would otherwise lowercase or throw).
    assert.doesNotThrow(() => new URL(captured.uri), `URI must be valid for "${serverName}"`);
    const parsed = new URL(captured.uri);
    assert.ok(/^[a-z][a-z0-9+.-]*:$/.test(parsed.protocol), `scheme must be valid: ${parsed.protocol}`);
    // The rendered content references the same (valid) URI.
    const result = await captured.handler(parsed);
    assert.equal(result.contents[0].uri, parsed.href);
  }
});
