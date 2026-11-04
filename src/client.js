'use strict';
const ERRORS = {
  ROOM_NOT_FOUND: '没有找到这个房间，请检查房间号', ROOM_FULL: '房间已经有两位玩家啦',
  ROOM_CLOSED: '房间已结束，重新创建一个吧', ROOM_EXPIRED: '房间已过期，重新创建一个吧',
  ROOM_UNAVAILABLE: '这个房间暂时无法恢复', ACTIVE_ROOM_EXISTS: '你还有一个房间，请先返回或退出',
  TOO_MANY_REQUESTS: '操作有点快，请稍后再试', SERVICE_BUSY: '服务暂时繁忙，请稍后重试',
  INVALID_WORD: '请输入 1–20 个字，不能包含换行', STALE_ATTEMPT: '已进入新尝试，请重新想一个词',
  STALE_ROUND: '已经进入新一轮啦', ALREADY_SUBMITTED: '你已经提交，等待搭档就好',
  NOT_PLAYING: '等待搭档加入后再提交', ROUND_NOT_FINISHED: '这一轮还没有结束',
  IDENTITY_REQUIRED: '微信身份暂时不可用，请重新进入游戏'
};
const LIVE = s => s && ['waiting', 'playing', 'matched'].includes(s.status);
const PENDING_KEY = 'wordtune.pending.v1';
class GameClient {
  constructor(platform) {
    this.wx = platform;
    this.page = 'home'; this.room = null; this.word = ''; this.code = '';
    this.message = ''; this.busy = false; this.online = true; this.foreground = true;
    this.syncing = false; this.watcher = null; this.watchGeneration = 0;
    this.retryTimer = null; this.heartbeatTimer = null; this.retryCount = 0;
    this.pending = null; this.onChange = () => {};
  }
  changed() { this.onChange(); }
  readPending() {
    try { const p = this.wx.getStorageSync(PENDING_KEY); if (p?.requestId && p?.action) this.pending = p; }
    catch (_) { /* A failed write blocks new mutations below. */ }
  }
  savePending(payload) {
    // Persist only the player's unconfirmed request; remove it after a definitive response.
    this.wx.setStorageSync(PENDING_KEY, payload); this.pending = payload;
  }
  clearPending() { this.wx.removeStorageSync(PENDING_KEY); this.pending = null; }
  async api(payload) {
    const response = await this.wx.cloud.callFunction({ name: 'gameApi', data: payload, config: { timeout: 65000 } });
    if (!response.result || typeof response.result.ok !== 'boolean') throw new Error('NETWORK');
    return response.result;
  }
  async start() {
    this.readPending(); this.prefill(this.wx.getLaunchOptionsSync?.());
    this.wx.onShow(options => { this.foreground = true; this.prefill(options); this.recover(); });
    this.wx.onHide(() => { this.foreground = false; this.stopSync(); this.changed(); });
    this.wx.onNetworkStatusChange?.(state => {
      this.online = state.isConnected;
      if (this.online && this.foreground) this.recover(); else { this.stopSync(); this.changed(); }
    });
    this.wx.getNetworkType?.({ success: s => { this.online = s.networkType !== 'none'; this.changed(); } });
    this.wx.showShareMenu?.({ menus: ['shareAppMessage'] });
    this.wx.onShareAppMessage?.(() => this.shareData());
    await this.recover();
  }
  prefill(options) {
    const code = options?.query?.roomCode;
    if (/^\d{6}$/.test(code || '') && !LIVE(this.room)) { this.code = code; this.page = 'join'; }
  }
  shareData() {
    return { title: '心有灵犀｜各想一个词，看看能不能想到一起', query: LIVE(this.room) ? `roomCode=${this.room.roomCode}` : '' };
  }
  accept(snapshot, enter = false) {
    if (!snapshot?.roomId) return;
    if (this.room?.roomId === snapshot.roomId && snapshot.version < this.room.version) return;
    const previous = this.room;
    this.room = { ...snapshot, viewId: snapshot.viewId || snapshot._id || previous?.viewId };
    if (!previous || previous.roomId !== snapshot.roomId || previous.round !== snapshot.round || previous.attempt !== snapshot.attempt) this.word = '';
    if (enter) this.page = 'room';
    if (!LIVE(this.room)) this.stopSync();
    this.changed();
  }
  async recover() {
    if (!this.foreground || !this.online || this.busy || this.syncing) return;
    this.syncing = true; this.message = ''; this.changed();
    try {
      if (this.pending) {
        const result = await this.api(this.pending);
        if (result.code === 'SERVICE_BUSY') throw new Error('RETRY_PENDING');
        this.clearPending();
        if (result.ok) this.accept(result.data, true); else this.message = ERRORS[result.code] || '操作未完成，请重试';
      }
      const result = await this.api({ action: 'resumeRoom' });
      if (result.ok && result.data.roomId) this.accept(result.data);
      else if (result.ok) { this.room = null; if (this.page === 'room') this.page = 'home'; }
      else this.message = ERRORS[result.code] || '房间暂时无法恢复';
      this.retryCount = 0;
      if (LIVE(this.room)) this.startSync();
    } catch (_) {
      this.message = this.pending ? '正在确认上次操作，点击重试不会重复提交' : '连接暂时中断，点击重试';
      this.scheduleRecovery();
    } finally { this.syncing = false; this.changed(); }
  }
  scheduleRecovery() {
    if (this.retryTimer || !this.foreground || !this.online) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retryCount++, 5));
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.recover(); }, delay);
  }
  stopSync() {
    this.watchGeneration++;
    const watcher = this.watcher; this.watcher = null;
    if (watcher) {
      try { Promise.resolve(watcher.close()).catch(() => {}); } catch (_) { /* The SDK may have already closed a failed socket. */ }
    }
    clearTimeout(this.retryTimer); this.retryTimer = null;
    clearInterval(this.heartbeatTimer); this.heartbeatTimer = null;
  }
  startSync() {
    this.stopSync();
    if (!this.foreground || !this.online || !LIVE(this.room)) return;
    const generation = this.watchGeneration, roomId = this.room.roomId;
    try {
      this.watcher = this.wx.cloud.database().collection('player_room_views')
        .where({ _id: this.room.viewId, _openid: '{openid}' }).watch({
          onChange: snapshot => {
            if (generation !== this.watchGeneration || this.room?.roomId !== roomId) return;
            if (snapshot.docs[0]) { this.accept(snapshot.docs[0]); this.retryCount = 0; }
          },
          onError: () => {
            if (generation !== this.watchGeneration) return;
            // watch closes itself on error; do not close the failed socket a second time.
            this.watcher = null;
            this.stopSync(); this.message = '同步中断，正在重新连接'; this.changed(); this.scheduleRecovery();
          }
        });
    } catch (_) { this.message = '同步中断，正在重新连接'; this.scheduleRecovery(); }
    this.heartbeatTimer = setInterval(async () => {
      if (!this.foreground || !this.online || this.busy || this.syncing || !LIVE(this.room)) return;
      try {
        const result = await this.api({ action: 'heartbeat', roomId });
        if (this.room?.roomId !== roomId) return;
        if (result.ok) this.accept(result.data);
        else { this.message = ERRORS[result.code] || '连接需要恢复'; this.stopSync(); this.scheduleRecovery(); }
      } catch (_) { this.stopSync(); this.scheduleRecovery(); }
    }, 35000);
  }
  async mutate(action, fields = {}) {
    if (this.busy || this.syncing) return;
    if (this.pending) { await this.recover(); return; }
    if (!this.online) { this.message = '网络断开啦，连接后再试'; this.changed(); return; }
    this.busy = true; this.message = ''; this.changed();
    let payload;
    try {
      payload = { action, requestId: `req_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`, ...fields };
      this.savePending(payload);
    } catch (_) { this.message = '无法保存操作进度，请检查设备存储'; this.busy = false; this.changed(); return; }
    try {
      const result = await this.api(payload);
      if (result.code === 'SERVICE_BUSY') throw new Error('RETRY_PENDING');
      this.clearPending();
      if (result.ok) { this.accept(result.data, true); if (LIVE(this.room)) this.startSync(); }
      else {
        this.message = ERRORS[result.code] || '操作未完成，请稍后重试';
        if (['STALE_ATTEMPT', 'STALE_ROUND', 'ALREADY_SUBMITTED'].includes(result.code)) this.scheduleRecovery();
      }
    } catch (_) { this.message = '正在确认操作结果，请点击重试'; this.scheduleRecovery(); }
    finally { this.busy = false; this.changed(); }
  }
  create() { return this.mutate('createRoom'); }
  join() {
    if (!/^\d{6}$/.test(this.code)) { this.message = '请输入 6 位数字房间号'; this.changed(); return; }
    return this.mutate('joinRoom', { roomCode: this.code });
  }
  submit() {
    const r = this.room, word = this.word.trim();
    if (!word || Array.from(word).length > 20 || /[\u0000-\u001F\u007F]/.test(word)) { this.message = ERRORS.INVALID_WORD; this.changed(); return; }
    if (!r || r.status !== 'playing' || r.players[r.ownSeat].submitted) return;
    return this.mutate('submitWord', { roomId: r.roomId, expectedRound: r.round, expectedAttempt: r.attempt, word });
  }
  ready() {
    const r = this.room;
    if (r?.status === 'matched' && !r.players[r.ownSeat].ready) return this.mutate('readyNextRound', { roomId: r.roomId, expectedRound: r.round });
  }
  leave() {
    this.wx.showModal({ title: '退出这个房间？', content: '退出会结束整个房间，搭档也需要重新加入。', confirmText: '退出房间', confirmColor: '#547D9B',
      success: result => { if (result.confirm && this.room) this.mutate('leaveRoom', { roomId: this.room.roomId }); } });
  }
  home() { this.page = 'home'; this.message = ''; this.changed(); }
  enter() { this.page = 'room'; this.changed(); }
}
module.exports = { GameClient, LIVE };
