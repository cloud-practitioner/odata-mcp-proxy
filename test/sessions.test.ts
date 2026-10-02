// Unit tests for the HTTP session store (F16): idle sessions are evicted and
// closed after the TTL, active sessions are kept, and eviction tears down the
// stored server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/server/sessions.js';

interface FakeSession {
  closed: boolean;
  close(): void;
}

function fakeSession(): FakeSession {
  return {
    closed: false,
    close() {
      this.closed = true;
    },
  };
}

test('sessions idle past the TTL are evicted and closed', async () => {
  let now = 1000;
  const store = new SessionStore<FakeSession>(100, (s) => s.close(), () => now);

  const stale = fakeSession();
  store.set('stale', stale);

  // Advance the clock past the TTL and insert a fresh session.
  now = 1101;
  const fresh = fakeSession();
  store.set('fresh', fresh);

  const evicted = await store.evictIdle();

  assert.deepEqual(evicted, ['stale']);
  assert.equal(stale.closed, true, 'evicted session must be closed');
  assert.equal(store.has('stale'), false);
  assert.equal(store.has('fresh'), true);
  assert.equal(fresh.closed, false, 'fresh session must survive');
  assert.equal(store.size, 1);
});

test('reading a session refreshes its activity so it is not evicted', async () => {
  let now = 0;
  const store = new SessionStore<FakeSession>(100, (s) => s.close(), () => now);
  store.set('s', fakeSession());

  now = 90;
  assert.ok(store.get('s'), 'session is still present'); // refreshes lastActivity to 90

  now = 180; // 90ms since last access, below the 100ms TTL
  assert.deepEqual(await store.evictIdle(), []);
  assert.equal(store.has('s'), true);

  now = 300; // now well past the TTL since the last access
  assert.deepEqual(await store.evictIdle(), ['s']);
});

test('startSweeping schedules eviction and stopSweeping halts it', async () => {
  let now = 0;
  const store = new SessionStore<FakeSession>(10, (s) => s.close(), () => now);
  const s = fakeSession();
  store.set('x', s);

  store.startSweeping(5);
  now = 100;
  // Give the interval a chance to fire.
  await new Promise((resolve) => setTimeout(resolve, 25));
  store.stopSweeping();

  assert.equal(store.has('x'), false, 'sweeper should have evicted the idle session');
  assert.equal(s.closed, true);
});
