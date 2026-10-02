// Unit tests for the config-validation gaps F10/F12:
//   - findUnknownCategories: an ENABLED_API_CATEGORIES value that matches no
//     entity set is reported rather than silently registering nothing (F12).
//   - asyncHandler: a thrown Express handler returns 500 instead of becoming
//     an unhandled rejection that crashes the process (F10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUnknownCategories, type EntitySetDefinition } from '../src/tools/registry.js';
import { asyncHandler } from '../src/server/http.js';

function def(category: string): EntitySetDefinition {
  return { entitySet: `E_${category || 'none'}`, description: 'd', category, keys: [], operations: {} };
}

const defs = [def('monitoring'), def('artifacts'), def('')];

// ─── F12: unknown category detection ─────────────────────────────────────────

test('findUnknownCategories treats ["all"] as matching everything', () => {
  assert.deepEqual(findUnknownCategories(['all'], defs), []);
});

test('findUnknownCategories returns requested categories that match no entity set', () => {
  assert.deepEqual(findUnknownCategories(['monitoring', 'typo'], defs), ['typo']);
});

test('findUnknownCategories accepts every known category', () => {
  assert.deepEqual(findUnknownCategories(['monitoring', 'artifacts'], defs), []);
});

test('findUnknownCategories reports all unknown categories, not just the first', () => {
  assert.deepEqual(findUnknownCategories(['nope', 'artifacts', 'alsonope'], defs), ['nope', 'alsonope']);
});

test('findUnknownCategories reports everything when no entity set is categorised', () => {
  assert.deepEqual(findUnknownCategories(['monitoring'], [def(''), def('')]), ['monitoring']);
});

// ─── F10: async handler returns 500 instead of crashing ──────────────────────

interface FakeRes {
  headersSent: boolean;
  statusCode?: number;
  body?: unknown;
  ended: boolean;
  status(code: number): FakeRes;
  json(payload: unknown): FakeRes;
  end(): void;
}

function fakeRes(headersSent = false): FakeRes {
  return {
    headersSent,
    ended: false,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { this.ended = true; },
  };
}

/** asyncHandler awaits a microtask queue flush; this lets the .catch run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('asyncHandler turns a thrown handler into a 500 JSON-RPC error', async () => {
  const res = fakeRes();
  const handler = asyncHandler(async () => { throw new Error('boom'); });
  handler({} as never, res as never);
  await flush();

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, {
    jsonrpc: '2.0',
    error: { code: -32603, message: 'Internal server error' },
    id: null,
  });
});

test('asyncHandler ends the response when headers were already sent', async () => {
  const res = fakeRes(true);
  const handler = asyncHandler(async () => { throw new Error('late'); });
  handler({} as never, res as never);
  await flush();

  assert.equal(res.statusCode, undefined, 'must not try to set a status after headers are sent');
  assert.equal(res.ended, true);
});

test('asyncHandler leaves a successful handler untouched', async () => {
  const res = fakeRes();
  let ran = false;
  const handler = asyncHandler(async () => { ran = true; });
  handler({} as never, res as never);
  await flush();

  assert.equal(ran, true);
  assert.equal(res.statusCode, undefined);
});
