'use strict';

const cloud = require('wx-server-sdk');
const { createGameService } = require('./service');
const { createWxStore } = require('./wx-store');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database({ throwOnNotFound: false });
const service = createGameService({ store: createWxStore(db) });
const APP_ID = 'wx31782b9e04ef9186';

exports.main = async event => {
  const context = cloud.getWXContext();
  try {
    if (context.SOURCE === 'wx_trigger') {
      return { ok: true, data: await service.cleanup() };
    }
    if (context.APPID !== APP_ID || !context.OPENID) return { ok: false, code: 'IDENTITY_REQUIRED' };
    return await service.execute(context.OPENID, event);
  } catch (error) {
    // Never log the event, the input words, the caller's identity, or raw SDK errors.
    const code = String(error.errCode || error.code || 'INTERNAL_ERROR');
    console.error('gameApi operation failed', { code: /^[A-Z0-9_-]{1,64}$/i.test(code) ? code : 'INTERNAL_ERROR' });
    return { ok: false, code: 'SERVICE_BUSY' };
  }
};
