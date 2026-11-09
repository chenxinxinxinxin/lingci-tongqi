'use strict';

const { createHash, randomInt, randomUUID } = require('node:crypto');

const DAY = 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const memberId = openid => digest(`member:${openid}`);
const viewId = (roomId, seat) => `${roomId}_${seat}`;
const submissionId = (room, seat) => `${room.id}_${room.round}_${room.attempt}_${seat}`;
const fail = code => ({ ok: false, code });
const success = data => ({ ok: true, data });
const isLive = (room, time) => room && room.expiresAt > time && ['waiting', 'playing', 'revealed', 'matched'].includes(room.status);
const profileOf = p => ({ nickname: p?.nickname || '', avatar: p?.avatar || '', ...(p?.wechatAuthorized ? { wechatAuthorized: true } : {}) });
const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);

// The store runs the entire callback atomically and retries only transaction conflicts.
// Tests inject an isolated in-memory store; production uses wx-server-sdk.
function createGameService({ store, now = Date.now, randomId = () => randomUUID().replace(/-/g, ''),
  randomCode = () => String(randomInt(1000000)).padStart(6, '0') }) {
  async function publish(tx, room) {
    for (let seat = 0; seat < room.members.length; seat++) {
      await tx.set('player_room_views', viewId(room.id, seat), {
        _openid: room.members[seat], roomId: room.id, roomCode: room.code,
        ownSeat: seat, status: room.status, round: room.round, attempt: room.attempt,
        players: [0, 1].map(index => ({
          seat: index, present: !!room.members[index], submitted: room.submitted[index],
          ready: room.ready[index], lastSeenAt: room.lastSeenAt[index], profile: profileOf(room.profiles?.[index])
        })),
        latestEvent: room.latestEvent, history: room.history || [], version: room.version, expiresAt: room.expiresAt
      });
    }
    await tx.set('rooms', room.id, room);
  }

  function snapshot(room, openid) {
    return { viewId: viewId(room.id, room.members.indexOf(openid)),
      roomId: room.id, roomCode: room.code, ownSeat: room.members.indexOf(openid),
      status: room.status, round: room.round, attempt: room.attempt,
      players: [0, 1].map(seat => ({ seat, present: !!room.members[seat],
        submitted: room.submitted[seat], ready: room.ready[seat], lastSeenAt: room.lastSeenAt[seat], profile: profileOf(room.profiles?.[seat]) })),
      latestEvent: room.latestEvent, history: room.history || [], version: room.version, expiresAt: room.expiresAt };
  }

  async function addEvent(tx, room, type, time, words) {
    room.sequence++;
    const event = { id: `${room.id}_${room.sequence}`, sequence: room.sequence, type, round: room.round,
      attempt: room.attempt, createdAt: time };
    if (Array.isArray(words)) {
      event.words = words;
      if (type === 'matched') event.matchedWord = words[0];
      room.history = [...(room.history || []), event].slice(-20);
    }
    room.latestEvent = event;
    await tx.set('room_events', event.id, { ...event, roomId: room.id, expiresAt: room.expiresAt + DAY });
  }

  async function finishRoom(tx, room, status, time) {
    if (['closed', 'expired'].includes(room.status)) return;
    for (let seat = 0; seat < room.members.length; seat++) {
      if (room.submitted[seat]) await tx.remove('round_submissions', submissionId(room, seat));
      const id = memberId(room.members[seat]);
      const membership = await tx.get('room_members', id);
      // An old room's cleanup must never detach someone from a newer room.
      if (membership && membership.roomId === room.id) {
        await tx.set('room_members', id, { ...membership, active: false, updatedAt: time });
      }
    }
    room.status = status;
    room.submitted = [false, false];
    room.ready = [false, false];
    room.version++;
    await addEvent(tx, room, status, time);
    await publish(tx, room);
  }

  async function activeMembership(tx, openid, time) {
    const membership = await tx.get('room_members', memberId(openid));
    if (!membership || !membership.active) return null;
    const room = await tx.get('rooms', membership.roomId);
    if (isLive(room, time)) return room;
    if (room && room.expiresAt <= time) await finishRoom(tx, room, 'expired', time);
    return null;
  }

  // Consumed separately so invalid room numbers also count towards the joining limit.
  async function rateLimit(openid, action, time) {
    const scope = action === 'joinRoom' ? 'join' : action === 'createRoom' ? 'create' : 'general';
    const maximum = scope === 'join' ? 12 : scope === 'create' ? 6 : 120;
    return store.transaction(async tx => {
      const id = digest(`limit:${openid}:${scope}`);
      let record = await tx.get('operation_limits', id);
      if (!record || time - record.windowStart >= 60000) record = { windowStart: time, count: 0 };
      if (record.count >= maximum) return false;
      await tx.set('operation_limits', id, { ...record, count: record.count + 1, expiresAt: time + DAY });
      return true;
    });
  }

  const mutationActions = new Set(['createRoom', 'joinRoom', 'submitWord', 'readyNextRound', 'leaveRoom', 'updateProfile']);
  const actions = new Set([...mutationActions, 'resumeRoom', 'heartbeat', 'getHistory']);

  async function execute(openid, input) {
    if (typeof openid !== 'string' || !openid) return fail('IDENTITY_REQUIRED');
    if (!input || typeof input !== 'object' || !actions.has(input.action)) return fail('INVALID_ACTION');
    const { action, requestId } = input;
    const mutation = mutationActions.has(action);
    if (mutation && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId))) return fail('INVALID_REQUEST_ID');
    if (!['createRoom', 'joinRoom', 'resumeRoom', 'updateProfile'].includes(action) && !validId(input.roomId)) return fail('INVALID_ROOM_ID');
    if (action === 'resumeRoom' && input.roomId !== undefined && !validId(input.roomId)) return fail('INVALID_ROOM_ID');
    if (action === 'joinRoom' && (typeof input.roomCode !== 'string' || !/^\d{6}$/.test(input.roomCode))) return fail('INVALID_ROOM_CODE');
    if (action === 'getHistory' && input.beforeSequence !== undefined && (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 1)) return fail('INVALID_SEQUENCE');
    let profile;
    if (action === 'updateProfile') {
      const p = input.profile;
      if (!p || typeof p.nickname !== 'string' || !p.nickname.trim() || Array.from(p.nickname.trim()).length > 16 || /[\u0000-\u001F\u007F]/.test(p.nickname)) return fail('INVALID_PROFILE');
      const avatar = p.avatar || '';
      if (typeof avatar !== 'string' || avatar.length > 40000 || (avatar && !/^https:\/\/(?:[a-z0-9-]+\.)*(?:qlogo\.cn|qpic\.cn)\/[^\s]+$/i.test(avatar) && !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(avatar))) return fail('INVALID_AVATAR');
      profile = { nickname: p.nickname.trim(), avatar, ...(p.wechatAuthorized === true && avatar ? { wechatAuthorized: true } : {}) };
    }
    if (['submitWord', 'readyNextRound'].includes(action) &&
      (!Number.isSafeInteger(input.expectedRound) || input.expectedRound < 1)) return fail('INVALID_ROUND');
    if (action === 'readyNextRound' && (!Number.isSafeInteger(input.expectedAttempt) || input.expectedAttempt < 1)) return fail('INVALID_ATTEMPT');
    let word;
    if (action === 'submitWord') {
      if (!Number.isSafeInteger(input.expectedAttempt) || input.expectedAttempt < 1) return fail('INVALID_ATTEMPT');
      if (typeof input.word !== 'string' || input.word.length > 256) return fail('INVALID_WORD');
      word = input.word.trim();
      if (!word || Array.from(word).length > 20 || /[\u0000-\u001F\u007F]/.test(word)) return fail('INVALID_WORD');
    }
    const time = now();
    if (!await rateLimit(openid, action, time)) return fail('TOO_MANY_REQUESTS');
    if (action === 'getHistory') {
      const allowed = await store.transaction(async tx => {
        const room = await tx.get('rooms', input.roomId);
        return room && room.members.includes(openid) && room.expiresAt > time;
      });
      if (!allowed) return fail('ROOM_UNAVAILABLE');
      return success(await store.findHistory(input.roomId, input.beforeSequence, 20));
    }
    // Values that may be reused by transaction retries are generated outside its callback.
    const newRoomId = randomId();
    const receiptId = mutation ? digest(`receipt:${openid}:${requestId}`) : null;
    const scope = { action, roomId: input.roomId || null, roomCode: input.roomCode || null,
      round: input.expectedRound || null, attempt: input.expectedAttempt || null };
    if (action === 'updateProfile') scope.profileHash = digest(JSON.stringify(profile));

    for (let codeTry = 0; codeTry < 8; codeTry++) {
      const roomCode = action === 'createRoom' ? randomCode() : null;
      const result = await store.transaction(async tx => {
        if (mutation) {
          const receipt = await tx.get('operation_receipts', receiptId);
          if (receipt && receipt.expiresAt > time) {
            if (Object.keys(scope).some(key => receipt.scope[key] !== scope[key])) return fail('REQUEST_ID_REUSED');
            if (action === 'updateProfile') {
              const member = await tx.get('room_members', memberId(openid));
              return success({ profile: profileOf(member?.profile), replayed: true });
            }
            const oldRoom = await tx.get('rooms', receipt.roomId);
            if (!oldRoom || !oldRoom.members.includes(openid)) return fail('ROOM_UNAVAILABLE');
            if (oldRoom.expiresAt <= time) await finishRoom(tx, oldRoom, 'expired', time);
            return success({ ...snapshot(oldRoom, openid), replayed: true });
          }
        }

        let room;
        if (action === 'updateProfile') {
          const id = memberId(openid);
          const member = await tx.get('room_members', id);
          await tx.set('room_members', id, { ...(member || {}), profile, updatedAt: time });
          room = member?.active ? await tx.get('rooms', member.roomId) : null;
          if (isLive(room, time) && room.members.includes(openid)) {
            room.profiles = room.profiles || [{}, {}]; room.profiles[room.members.indexOf(openid)] = profile;
            room.version++; await publish(tx, room);
          }
          await tx.set('operation_receipts', receiptId, { scope, createdAt: time, expiresAt: time + DAY });
          return success({ profile });
        } else if (action === 'createRoom') {
          room = await activeMembership(tx, openid, time);
          if (!room) {
            const member = await tx.get('room_members', memberId(openid));
            const reservation = await tx.get('room_codes', roomCode);
            if (reservation && reservation.expiresAt > time) return fail('CODE_COLLISION');
            room = { id: newRoomId, code: roomCode, members: [openid], status: 'waiting',
              round: 1, attempt: 1, submitted: [false, false], ready: [false, false],
              lastSeenAt: [time, null], version: 1, sequence: 0, latestEvent: null,
              profiles: [profileOf(member?.profile), {}], history: [], createdAt: time, expiresAt: time + DAY };
            await tx.set('room_codes', roomCode, { roomId: room.id, expiresAt: room.expiresAt });
            await tx.set('room_members', memberId(openid), { roomId: room.id, openid, seat: 0, active: true, profile: profileOf(member?.profile), updatedAt: time });
            await publish(tx, room);
          }
        } else if (action === 'joinRoom') {
          const reservation = await tx.get('room_codes', input.roomCode);
          if (!reservation) return fail('ROOM_NOT_FOUND');
          room = await tx.get('rooms', reservation.roomId);
          if (!room) return fail('ROOM_NOT_FOUND');
          if (room.expiresAt <= time) {
            await finishRoom(tx, room, 'expired', time);
            return fail('ROOM_EXPIRED');
          }
          if (room.status === 'closed') return fail('ROOM_CLOSED');
          if (!room.members.includes(openid)) {
            if (room.members.length >= 2) return fail('ROOM_FULL');
            const current = await activeMembership(tx, openid, time);
            if (current && current.id !== room.id) return fail('ACTIVE_ROOM_EXISTS');
            const member = await tx.get('room_members', memberId(openid));
            room.members.push(openid);
            room.lastSeenAt[1] = time;
            room.status = 'playing';
            room.profiles = room.profiles || [{}, {}]; room.profiles[1] = profileOf(member?.profile);
            room.version++;
            await tx.set('room_members', memberId(openid), { roomId: room.id, openid, seat: 1, active: true, profile: profileOf(member?.profile), updatedAt: time });
            await addEvent(tx, room, 'started', time);
            await publish(tx, room);
          }
        } else {
          if (action === 'resumeRoom' && !input.roomId) {
            room = await activeMembership(tx, openid, time);
            if (!room) {
              const member = await tx.get('room_members', memberId(openid));
              return success({ room: null, profile: profileOf(member?.profile) });
            }
          } else {
            room = await tx.get('rooms', input.roomId);
          }
          if (!room || !room.members.includes(openid)) return fail('ROOM_UNAVAILABLE');
          if (room.expiresAt <= time) {
            await finishRoom(tx, room, 'expired', time);
            return fail('ROOM_EXPIRED');
          }
          if (['closed', 'expired'].includes(room.status)) {
            if (['resumeRoom', 'leaveRoom'].includes(action)) return success(snapshot(room, openid));
            return fail('ROOM_CLOSED');
          }
          const seat = room.members.indexOf(openid);
          if (action === 'submitWord') {
            if (room.status !== 'playing') return fail('NOT_PLAYING');
            if (input.expectedRound !== room.round || input.expectedAttempt !== room.attempt) return fail('STALE_ATTEMPT');
            if (room.submitted[seat]) return fail('ALREADY_SUBMITTED');
            const otherSeat = 1 - seat;
            if (!room.submitted[otherSeat]) {
              await tx.set('round_submissions', submissionId(room, seat), {
                roomId: room.id, round: room.round, attempt: room.attempt,
                seat, word, requestId, createdAt: time, expiresAt: room.expiresAt
              });
              room.submitted[seat] = true;
            } else {
              const other = await tx.get('round_submissions', submissionId(room, otherSeat));
              if (!other || other.round !== room.round || other.attempt !== room.attempt) throw new Error('SUBMISSION_STATE_INCONSISTENT');
              const matched = word === other.word;
              await tx.remove('round_submissions', submissionId(room, otherSeat));
              // Reveal both words only in the transaction that accepts the second submission.
              const words = []; words[seat] = word; words[otherSeat] = other.word;
              await addEvent(tx, room, matched ? 'matched' : 'mismatch', time, words);
              room.submitted = [false, false];
              room.ready = [false, false];
              room.status = matched ? 'matched' : 'revealed';
            }
            room.lastSeenAt[seat] = time;
            room.version++;
            await publish(tx, room);
          } else if (action === 'readyNextRound') {
            if (input.expectedRound !== room.round) return fail('STALE_ROUND');
            if (!['matched', 'revealed'].includes(room.status)) return fail('ROUND_NOT_FINISHED');
            if (input.expectedAttempt !== room.attempt) return fail('STALE_ATTEMPT');
            const matched = room.status === 'matched';
            room.ready[seat] = true;
            if (room.ready.every(Boolean)) {
              if (matched) { room.round++; room.attempt = 1; } else room.attempt++;
              room.ready = [false, false];
              room.status = 'playing';
              await addEvent(tx, room, matched ? 'round_started' : 'attempt_started', time);
            }
            room.lastSeenAt[seat] = time;
            room.version++;
            await publish(tx, room);
          } else if (action === 'leaveRoom') {
            await finishRoom(tx, room, 'closed', time);
          } else if (time - room.lastSeenAt[seat] >= 30000) {
            room.lastSeenAt[seat] = time;
            room.version++;
            await publish(tx, room);
          }
        }
        if (mutation) await tx.set('operation_receipts', receiptId, {
          scope, roomId: room.id, createdAt: time, expiresAt: room.expiresAt + DAY
        });
        return success(snapshot(room, openid));
      });
      if (result.code !== 'CODE_COLLISION') return result;
    }
    return fail('ROOM_CODE_BUSY');
  }

  async function cleanup() {
    const time = now();
    const candidates = await store.findExpiredRooms(time, 25);
    let expired = 0;
    for (const id of candidates) {
      const changed = await store.transaction(async tx => {
        const room = await tx.get('rooms', id);
        if (!room || room.expiresAt > time || ['closed', 'expired'].includes(room.status)) return false;
        await finishRoom(tx, room, 'expired', time);
        return true;
      });
      if (changed) expired++;
    }
    const purged = await store.purgeExpired(time, 25);
    return { expired, purged, batchLimit: 25 };
  }

  return { execute, cleanup };
}

module.exports = { createGameService, DAY, memberId, viewId, submissionId };
