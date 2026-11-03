'use strict';

function createWxStore(db) {
  return {
    transaction(work) {
      return db.runTransaction(async transaction => work({
        async get(collection, id) {
          const result = await transaction.collection(collection).doc(id).get();
          if (!result.data) return null;
          const { _id, ...data } = result.data;
          return data;
        },
        async set(collection, id, data) {
          await transaction.collection(collection).doc(id).set({ data });
        },
        async remove(collection, id) {
          await transaction.collection(collection).doc(id).remove();
        }
      }), 5);
    },
    async findExpiredRooms(time, limit) {
      const result = await db.collection('rooms').where({
        status: db.command.in(['waiting', 'playing', 'matched']),
        expiresAt: db.command.lte(time)
      }).limit(limit).get();
      return result.data.map(room => room._id);
    },
    async purgeExpired(time, limit) {
      let count = 0;
      for (const collection of ['operation_receipts', 'operation_limits', 'room_events']) {
        const result = await db.collection(collection).where({ expiresAt: db.command.lte(time) }).limit(limit).get();
        for (const record of result.data) {
          // Re-read in a transaction: a receipt/rate record may have been renewed.
          const removed = await db.runTransaction(async tx => {
            const current = await tx.collection(collection).doc(record._id).get();
            if (current.data && current.data.expiresAt <= time) {
              await tx.collection(collection).doc(record._id).remove();
              return true;
            }
            return false;
          }, 5);
          if (removed) count++;
        }
      }
      return count;
    }
  };
}

module.exports = { createWxStore };
