'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GameClient } = require('../src/client');
const { createGameService } = require('../cloudfunctions/gameApi/service');
const { createMemoryStore } = require('./memory-store');

// These two identities exist only in this isolated local model, never in WeChat.
function harness() {
  const service = createGameService({ store: createMemoryStore() });
  function player(identity) {
    const storage = new Map(), calls = [], watches = [];
    let loseResponse = false, busyResponse = false;
    const wx = {
      getStorageSync: k => structuredClone(storage.get(k)),
      setStorageSync: (k, v) => storage.set(k, structuredClone(v)), removeStorageSync: k => storage.delete(k),
      cloud: {
        async callFunction({ data }) {
          calls.push(structuredClone(data));
          if (busyResponse) { busyResponse = false; return { result: { ok: false, code: 'SERVICE_BUSY' } }; }
          const result = await service.execute(identity, data);
          if (loseResponse) { loseResponse = false; throw new Error('Synthetic lost response'); }
          return { result };
        },
        database: () => ({ collection: () => ({ where: query => ({ watch: callbacks => {
          const watch = { query, callbacks, closed: false, close() { this.closed = true; return Promise.resolve(); } };
          watches.push(watch); return watch;
        } }) }) })
      }
    };
    const client = new GameClient(wx);
    return { client, wx, storage, calls, watches,
      loseNextResponse() { loseResponse = true; }, busyNextResponse() { busyResponse = true; } };
  }
  return { player };
}

test('client replays the saved submission after reload without leaking it into the next attempt', async t => {
  const h = harness(), a = h.player('synthetic-A'), b = h.player('synthetic-B');
  const clients = [a.client, b.client]; t.after(() => clients.forEach(c => c.stopSync()));
  await a.client.create(); b.client.code = a.client.room.roomCode; await b.client.join(); await a.client.recover();
  a.client.word = '云朵'; a.loseNextResponse(); await a.client.submit();
  assert.ok(a.client.pending); assert.equal(a.storage.size, 1);
  const submittedRequest = a.calls.at(-1); a.client.stopSync();
  b.client.word = '星星'; await b.client.submit(); assert.equal(b.client.room.attempt, 2);
  const reloaded = new GameClient(a.wx); clients.push(reloaded); reloaded.readPending(); await reloaded.recover();
  assert.deepEqual(a.calls.at(-2), submittedRequest);
  assert.equal(reloaded.pending, null); assert.equal(a.storage.size, 0);
  assert.equal(reloaded.room.attempt, 2); assert.equal(reloaded.room.players[0].submitted, false);
});

test('watch replacement closes old connection and ignores callbacks from it', async t => {
  const a = harness().player('synthetic-A'); t.after(() => a.client.stopSync());
  await a.client.create(); const first = a.watches[0]; await a.client.recover();
  assert.equal(first.closed, true); assert.equal(a.watches.length, 2);
  assert.deepEqual(a.watches[1].query, { _id: a.client.room.viewId, _openid: '{openid}' });
  first.callbacks.onChange({ docs: [{ ...a.client.room, status: 'closed', version: 999 }] });
  assert.equal(a.client.room.status, 'waiting');
  a.client.stopSync(); assert.equal(a.watches[1].closed, true);
});

test('uncertain service response preserves request id and blocks a new mutation', async t => {
  const a = harness().player('synthetic-A'); t.after(() => a.client.stopSync());
  a.busyNextResponse(); await a.client.create(); const pending = structuredClone(a.client.pending);
  assert.ok(pending); await a.client.create();
  assert.deepEqual(a.calls[1], pending); assert.equal(a.client.pending, null);
  assert.equal(a.client.room.status, 'waiting');
});

test('two local clients reach match and wait for both next-round confirmations', async t => {
  const h = harness(), a = h.player('synthetic-A'), b = h.player('synthetic-B');
  t.after(() => { a.client.stopSync(); b.client.stopSync(); });
  await a.client.create(); b.client.code = a.client.room.roomCode; await b.client.join(); await a.client.recover();
  a.client.word = '月亮'; b.client.word = '月亮'; await Promise.all([a.client.submit(), b.client.submit()]);
  await a.client.recover(); assert.equal(a.client.room.status, 'matched');
  await a.client.ready(); assert.equal(a.client.room.status, 'matched');
  await b.client.recover(); await b.client.ready(); await a.client.recover();
  assert.equal(a.client.room.round, 2); assert.equal(a.client.room.status, 'playing'); assert.equal(a.client.word, '');
});
