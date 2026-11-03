'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGameService, DAY } = require('../cloudfunctions/gameApi/service');
const { createMemoryStore } = require('./memory-store');

function fixture() {
  let time = 1800000000000;
  let id = 0;
  let request = 0;
  let code = 0;
  const store = createMemoryStore();
  const service = createGameService({ store, now: () => time,
    randomId: () => (++id).toString(16).padStart(32, '0'),
    randomCode: () => String(code++).padStart(6, '0') });
  const send = (user, action, data = {}) => service.execute(user, {
    action, requestId: `synthetic_request_${++request}`, ...data
  });
  async function pair() {
    const created = await send('synthetic-player-A', 'createRoom');
    assert.equal(created.ok, true);
    const joined = await send('synthetic-player-B', 'joinRoom', { roomCode: created.data.roomCode });
    assert.equal(joined.ok, true);
    return { roomId: joined.data.roomId, expectedRound: 1, expectedAttempt: 1 };
  }
  return { store, service, send, pair, advance: milliseconds => { time += milliseconds; } };
}

test('room code preserves leading zeros and existing members keep their seat', async () => {
  const f = fixture();
  const created = await f.send('synthetic-player-A', 'createRoom');
  assert.equal(created.data.roomCode, '000000');
  const again = await f.send('synthetic-player-A', 'joinRoom', { roomCode: '000000' });
  assert.equal(again.data.ownSeat, 0);
  assert.equal(again.data.players.filter(player => player.present).length, 1);
  const joined = await f.send('synthetic-player-B', 'joinRoom', { roomCode: '000000' });
  assert.equal(joined.data.ownSeat, 1);
  assert.equal(joined.data.status, 'playing');
  assert.equal(f.store.all('rooms').length, 1);
});

test('a second create command resumes the existing live room', async () => {
  const f = fixture();
  const first = await f.send('synthetic-player-A', 'createRoom');
  const second = await f.send('synthetic-player-A', 'createRoom');
  assert.equal(first.data.roomId, second.data.roomId);
  assert.equal(f.store.all('rooms').length, 1);
});

test('first submission publishes status and keeps the word in the private collection', async () => {
  const f = fixture();
  const room = await f.pair();
  const result = await f.send('synthetic-player-A', 'submitWord', { ...room, word: '苹果' });
  assert.equal(result.data.players[0].submitted, true);
  assert.equal(f.store.all('round_submissions')[0].word, '苹果');
  const shared = JSON.stringify([result, f.store.all('rooms'), f.store.all('player_room_views'), f.store.all('operation_receipts')]);
  assert.equal(shared.includes('苹果'), false);
  const restored = await f.send('synthetic-player-B', 'resumeRoom', { roomId: room.roomId });
  assert.equal(restored.data.players[0].submitted, true);
  assert.equal(JSON.stringify(restored).includes('苹果'), false);
});

test('simultaneous equal submissions settle once and remove private words', async () => {
  const f = fixture();
  const room = await f.pair();
  const results = await Promise.all([
    f.send('synthetic-player-A', 'submitWord', { ...room, word: ' 苹果 ' }),
    f.send('synthetic-player-B', 'submitWord', { ...room, word: '苹果' })
  ]);
  assert.ok(results.every(result => result.ok));
  const state = f.store.all('rooms')[0];
  assert.equal(state.status, 'matched');
  assert.equal(state.latestEvent.matchedWord, '苹果');
  assert.equal(f.store.all('room_events').filter(event => event.type === 'matched').length, 1);
  assert.equal(f.store.all('round_submissions').length, 0);
  assert.ok(f.store.conflictCount > 0);
  assert.deepEqual(f.store.all('player_room_views').map(view => view.status), ['matched', 'matched']);
});

test('different words start one new attempt without recording either answer', async () => {
  const f = fixture();
  const room = await f.pair();
  await Promise.all([
    f.send('synthetic-player-A', 'submitWord', { ...room, word: '苹果' }),
    f.send('synthetic-player-B', 'submitWord', { ...room, word: '香蕉' })
  ]);
  const state = f.store.all('rooms')[0];
  assert.equal(state.attempt, 2);
  assert.equal(state.status, 'playing');
  assert.equal(state.latestEvent.type, 'mismatch');
  assert.equal(f.store.all('round_submissions').length, 0);
  const persisted = JSON.stringify([...f.store.records.values()]);
  assert.equal(persisted.includes('苹果'), false);
  assert.equal(persisted.includes('香蕉'), false);
});

test('internal spacing and punctuation remain significant', async () => {
  const f = fixture();
  const room = await f.pair();
  await f.send('synthetic-player-B', 'submitWord', { ...room, word: '开 心' });
  await f.send('synthetic-player-A', 'submitWord', { ...room, word: '开心' });
  const second = { ...room, expectedAttempt: 2 };
  await f.send('synthetic-player-A', 'submitWord', { ...second, word: '苹果！' });
  await f.send('synthetic-player-B', 'submitWord', { ...second, word: '苹果' });
  assert.equal(f.store.all('rooms')[0].attempt, 3);
});

test('next round starts only when both players are ready, even concurrently', async () => {
  const f = fixture();
  const room = await f.pair();
  await f.send('synthetic-player-A', 'submitWord', { ...room, word: '星星' });
  await f.send('synthetic-player-B', 'submitWord', { ...room, word: '星星' });
  const first = await f.send('synthetic-player-A', 'readyNextRound', room);
  assert.equal(first.data.status, 'matched');
  assert.deepEqual(first.data.players.map(player => player.ready), [true, false]);
  await Promise.all([
    f.send('synthetic-player-A', 'readyNextRound', room),
    f.send('synthetic-player-B', 'readyNextRound', room)
  ]);
  const state = f.store.all('rooms')[0];
  assert.equal(state.round, 2);
  assert.equal(state.attempt, 1);
  assert.equal(state.status, 'playing');
  assert.deepEqual(state.ready, [false, false]);
  assert.equal(f.store.all('room_events').filter(event => event.type === 'round_started').length, 1);
});

test('retrying a lost submission response never submits the previous answer into the next attempt', async () => {
  const f = fixture();
  const room = await f.pair();
  const command = { ...room, word: '苹果', requestId: 'synthetic_lost_response' };
  await f.send('synthetic-player-A', 'submitWord', command);
  await f.send('synthetic-player-B', 'submitWord', { ...room, word: '香蕉' });
  const replay = await f.send('synthetic-player-A', 'submitWord', command);
  assert.equal(replay.ok, true);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.attempt, 2);
  assert.equal(f.store.all('round_submissions').length, 0);
  assert.deepEqual(replay.data.players.map(player => player.submitted), [false, false]);
});

test('a delayed command from a previous attempt leaves the new attempt unchanged', async () => {
  const f = fixture();
  const room = await f.pair();
  await f.send('synthetic-player-A', 'submitWord', { ...room, word: '云' });
  await f.send('synthetic-player-B', 'submitWord', { ...room, word: '雨' });
  const delayed = await f.send('synthetic-player-A', 'submitWord', { ...room, word: '云' });
  assert.equal(delayed.code, 'STALE_ATTEMPT');
  assert.equal(f.store.all('rooms')[0].attempt, 2);
  assert.equal(f.store.all('round_submissions').length, 0);
});

test('offline recovery and heartbeats preserve a confirmed submission', async () => {
  const f = fixture();
  const room = await f.pair();
  await f.send('synthetic-player-A', 'submitWord', { ...room, word: '晴天' });
  f.advance(3 * 60 * 1000);
  const restored = await f.send('synthetic-player-A', 'resumeRoom');
  assert.equal(restored.data.players[0].submitted, true);
  await f.send('synthetic-player-B', 'heartbeat', { roomId: room.roomId });
  assert.equal(f.store.all('round_submissions').length, 1);
  await f.send('synthetic-player-B', 'submitWord', { ...room, word: '晴天' });
  assert.equal(f.store.all('rooms')[0].status, 'matched');
});

test('explicit departure closes both views and clears the pending submission', async () => {
  const f = fixture();
  const room = await f.pair();
  await f.send('synthetic-player-A', 'submitWord', { ...room, word: '天空' });
  await f.send('synthetic-player-B', 'leaveRoom', { roomId: room.roomId });
  assert.deepEqual(f.store.all('player_room_views').map(view => view.status), ['closed', 'closed']);
  assert.equal(f.store.all('round_submissions').length, 0);
  assert.ok(f.store.all('room_members').every(member => member.active === false));
});

test('expiry cleanup removes pending words and is safe to run repeatedly', async () => {
  const f = fixture();
  const room = await f.pair();
  await f.send('synthetic-player-A', 'submitWord', { ...room, word: '晚安' });
  f.advance(DAY + 1);
  const first = await f.service.cleanup();
  const again = await f.service.cleanup();
  assert.equal(first.expired, 1);
  assert.equal(again.expired, 0);
  assert.equal(f.store.all('rooms')[0].status, 'expired');
  assert.equal(f.store.all('round_submissions').length, 0);
  assert.deepEqual(f.store.all('player_room_views').map(view => view.status), ['expired', 'expired']);
});

test('room creation resumes cleanly after the previous room expires', async () => {
  const f = fixture();
  const room = await f.pair();
  await f.send('synthetic-player-A', 'submitWord', { ...room, word: '月亮' });
  f.advance(DAY + 1);
  const next = await f.send('synthetic-player-A', 'createRoom');
  assert.equal(next.ok, true);
  assert.notEqual(next.data.roomId, room.roomId);
  assert.equal(f.store.all('round_submissions').length, 0);
  assert.equal(f.store.all('room_members').find(member => member.openid === 'synthetic-player-A').roomId, next.data.roomId);
});

test('a thrown transaction discards all of its writes', async () => {
  const store = createMemoryStore();
  await assert.rejects(store.transaction(async tx => {
    await tx.set('synthetic', 'record', { value: 1 });
    throw new Error('Synthetic storage failure');
  }), /Synthetic storage failure/);
  assert.equal(store.all('synthetic').length, 0);
});

test('a room code collision retries with a different reserved code', async () => {
  const store = createMemoryStore();
  const codes = ['000007', '000007', '000008'];
  let id = 0;
  const service = createGameService({ store, now: () => 1800000000000,
    randomCode: () => codes.shift(), randomId: () => (++id).toString(16).padStart(32, '0') });
  const first = await service.execute('synthetic-player-A', { action: 'createRoom', requestId: 'synthetic_create_A' });
  const second = await service.execute('synthetic-player-C', { action: 'createRoom', requestId: 'synthetic_create_C' });
  assert.equal(first.data.roomCode, '000007');
  assert.equal(second.data.roomCode, '000008');
  assert.equal(store.all('room_codes').length, 2);
});

test('concurrent deliveries of one command create only one private submission', async () => {
  const f = fixture();
  const room = await f.pair();
  const command = { ...room, word: '蓝天', requestId: 'synthetic_same_command' };
  const results = await Promise.all([
    f.send('synthetic-player-A', 'submitWord', command),
    f.send('synthetic-player-A', 'submitWord', command)
  ]);
  assert.ok(results.every(result => result.ok));
  assert.equal(results.filter(result => result.data.replayed).length, 1);
  assert.equal(f.store.all('round_submissions').length, 1);
});
