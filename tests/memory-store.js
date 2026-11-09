'use strict';

const assert = require('node:assert/strict');

// Isolated synthetic test data only. No connection to the real cloud database.
// Optimistic read versions force overlapping commands to retry from a fresh snapshot.
function createMemoryStore() {
  const records = new Map();
  const versions = new Map();
  let conflictCount = 0;
  const key = (collection, id) => `${collection}/${id}`;
  const copy = value => value === undefined ? null : structuredClone(value);
  return {
    records,
    get conflictCount() { return conflictCount; },
    all(collection) {
      return [...records.entries()].filter(([id]) => id.startsWith(`${collection}/`)).map(([, value]) => copy(value));
    },
    async transaction(work) {
      for (let attempt = 0; attempt < 40; attempt++) {
        const snapshot = new Map([...records].map(([id, value]) => [id, copy(value)]));
        const initialVersions = new Map(versions);
        const reads = new Map();
        const writes = new Map();
        const read = id => {
          if (!reads.has(id)) reads.set(id, initialVersions.get(id) || 0);
          return copy(writes.has(id) ? writes.get(id) : snapshot.get(id));
        };
        const result = await work({
          async get(collection, id) { return read(key(collection, id)); },
          async set(collection, id, value) {
            const recordKey = key(collection, id);
            read(recordKey);
            assert.ok(!('_id' in value));
            writes.set(recordKey, copy(value));
          },
          async remove(collection, id) {
            const recordKey = key(collection, id);
            read(recordKey);
            writes.set(recordKey, null);
          }
        });
        if ([...reads].some(([id, version]) => (versions.get(id) || 0) !== version)) {
          conflictCount++;
          continue;
        }
        for (const [id, value] of writes) {
          if (value === null) records.delete(id);
          else records.set(id, copy(value));
          versions.set(id, (versions.get(id) || 0) + 1);
        }
        return result;
      }
      throw new Error('Synthetic transaction retry limit reached');
    },
    async findExpiredRooms(time, limit) {
      return this.all('rooms').filter(room => room.expiresAt <= time &&
        ['waiting', 'playing', 'revealed', 'matched'].includes(room.status)).slice(0, limit).map(room => room.id);
    },
    async findHistory(roomId, beforeSequence, limit) {
      const results = this.all('room_events').filter(e => e.roomId === roomId && ['mismatch', 'matched'].includes(e.type) && e.sequence && (!beforeSequence || e.sequence < beforeSequence))
        .sort((a, b) => b.sequence - a.sequence);
      return { events: results.slice(0, limit), hasMore: results.length > limit };
    },
    async purgeExpired(time, limit) {
      let removed = 0;
      for (const collection of ['operation_receipts', 'operation_limits', 'room_events']) {
        let count = 0;
        for (const [id, value] of records) {
          if (count >= limit) break;
          if (id.startsWith(`${collection}/`) && value.expiresAt <= time) {
            records.delete(id);
            versions.set(id, (versions.get(id) || 0) + 1);
            count++;
            removed++;
          }
        }
      }
      return removed;
    }
  };
}

module.exports = { createMemoryStore };
