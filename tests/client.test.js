'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GameClient } = require('../src/client');
const { createGameService } = require('../cloudfunctions/gameApi/service');
const { createMemoryStore } = require('./memory-store');

// These two identities exist only in this isolated local model, never in WeChat.
function harness() {
  const service = createGameService({ store: createMemoryStore() });
  function player(identity, authorized = true) {
    const storage = new Map(), calls = [], watches = [];
    const initialProfile = { nickname: '测试玩家', avatar: 'https://thirdwx.qlogo.cn/mmopen/test/132', wechatAuthorized: true };
    const initialized = authorized ? service.execute(identity, { action: 'updateProfile', requestId: 'synthetic_initial_profile', profile: initialProfile }) : Promise.resolve();
    let loseResponse = false, busyResponse = false;
    const wx = {
      getStorageSync: k => structuredClone(storage.get(k)),
      setStorageSync: (k, v) => storage.set(k, structuredClone(v)), removeStorageSync: k => storage.delete(k),
      cloud: {
        async callFunction({ data }) {
          await initialized;
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
    if (authorized) { client.profile = initialProfile; client.page = 'home'; }
    return { client, wx, storage, calls, watches,
      loseNextResponse() { loseResponse = true; }, busyNextResponse() { busyResponse = true; } };
  }
  return { player, service };
}

test('client replays the saved submission after reload without leaking it into the next attempt', async t => {
  const h = harness(), a = h.player('synthetic-A'), b = h.player('synthetic-B');
  const clients = [a.client, b.client]; t.after(() => clients.forEach(c => c.stopSync()));
  await a.client.create(); b.client.code = a.client.room.roomCode; await b.client.join(); await a.client.recover();
  a.client.word = '云朵'; a.loseNextResponse(); await a.client.submit();
  assert.ok(a.client.pending); assert.equal(a.storage.size, 1);
  const submittedRequest = a.calls.at(-1); a.client.stopSync();
  b.client.word = '星星'; await b.client.submit(); assert.equal(b.client.room.status, 'revealed');
  const reloaded = new GameClient(a.wx); clients.push(reloaded); reloaded.readPending(); await reloaded.recover();
  assert.deepEqual(a.calls.at(-2), submittedRequest);
  assert.equal(reloaded.pending, null); assert.equal(a.storage.size, 0);
  assert.equal(reloaded.room.attempt, 1); assert.equal(reloaded.room.players[0].submitted, false);
  assert.deepEqual(reloaded.history[0].words, ['云朵', '星星']);
  await reloaded.ready(); await b.client.ready(); await reloaded.recover();
  assert.equal(reloaded.room.attempt, 2); assert.equal(reloaded.word, '');
  assert.deepEqual(reloaded.history[0].words, ['云朵', '星星']);
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

test('profile save retries after a lost response without navigating into a nonexistent room', async t => {
  const a = harness().player('synthetic-A'); t.after(() => a.client.stopSync());
  a.client.editProfile(); a.client.profileDraft = { nickname: '云朵', avatar: 'https://thirdwx.qlogo.cn/mmopen/test/132', wechatAuthorized: true };
  a.loseNextResponse(); await a.client.saveProfile();
  assert.equal(a.client.pending.action, 'updateProfile');
  await a.client.recover();
  assert.equal(a.client.pending, null); assert.equal(a.client.page, 'home');
  assert.deepEqual(a.client.profile, { nickname: '云朵', avatar: 'https://thirdwx.qlogo.cn/mmopen/test/132', wechatAuthorized: true });
  assert.equal(a.client.room, null);
});

test('entry requires saved WeChat profile, survives reload, and retains invitation code', async t => {
  const a = harness().player('synthetic-new', false); t.after(() => a.client.stopSync());
  a.client.prefill({ query: { roomCode: '001234' } });
  await a.client.recover();
  assert.equal(a.client.page, 'profile'); assert.equal(a.client.code, '001234');
  const calls = a.calls.length;
  await a.client.create(); await a.client.join();
  assert.equal(a.calls.length, calls); assert.equal(a.client.room, null);
  a.client.profileDraft = { nickname: '微信玩家', avatar: 'https://thirdwx.qlogo.cn/mmopen/test/132', wechatAuthorized: true };
  a.loseNextResponse(); await a.client.saveProfile();
  assert.equal(a.client.profileReady, false); assert.equal(a.client.page, 'profile');
  const reloaded = new GameClient(a.wx); t.after(() => reloaded.stopSync());
  reloaded.readPending(); await reloaded.recover();
  assert.equal(reloaded.profileReady, true); assert.equal(reloaded.page, 'home');
});

test('confirmed exit returns to lobby and old watch cannot restore the room', async t => {
  const a = harness().player('synthetic-exit'); t.after(() => a.client.stopSync());
  await a.client.create(); const oldWatch = a.watches.at(-1), oldRoom = a.client.room;
  a.client.home();
  a.wx.showModal = options => options.success({ confirm: true });
  a.client.leave();
  // The modal callback dispatches the async mutation.
  while (a.client.busy) await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.client.room, null); assert.equal(a.client.page, 'home');
  assert.equal(a.client.message, '');
  assert.equal(oldWatch.closed, true);
  oldWatch.callbacks.onChange({ docs: [{ ...oldRoom, version: 999 }] });
  assert.equal(a.client.room, null);
  await a.client.create(); assert.notEqual(a.client.room.roomId, oldRoom.roomId);
});

test('reconnecting after many unseen results leaves no hidden gap in paged history', async t => {
  const h = harness(), a = h.player('synthetic-A'); t.after(() => a.client.stopSync());
  await a.client.create();
  let request = 0;
  const send = (user, action, data) => h.service.execute(user, { action, requestId: `synthetic_history_gap_${++request}`, ...data });
  const joined = await send('synthetic-B', 'joinRoom', { roomCode: a.client.room.roomCode });
  const room = { roomId: joined.data.roomId, expectedRound: 1 };
  async function attempts(from, to) {
    for (let attempt = from; attempt <= to; attempt++) {
      const current = { ...room, expectedAttempt: attempt };
      for (const user of ['synthetic-A', 'synthetic-B']) {
        const result = await send(user, 'submitWord', { ...current, word: user }); assert.equal(result.ok, true);
      }
      for (const user of ['synthetic-A', 'synthetic-B']) await send(user, 'readyNextRound', current);
    }
  }
  await attempts(1, 5); await a.client.recover(); await a.client.loadHistory();
  assert.equal(a.client.history.length, 5); assert.equal(a.client.historyMore, false);
  await attempts(6, 35); await a.client.recover();
  assert.equal(a.client.historyMore, true);
  await a.client.loadHistory();
  assert.equal(a.client.history.length, 35); assert.equal(a.client.historyMore, false);
  assert.deepEqual(a.client.history.map(e => e.attempt), Array.from({ length: 35 }, (_, i) => 35 - i));
});
