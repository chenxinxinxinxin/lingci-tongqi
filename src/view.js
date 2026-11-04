'use strict';
const { LIVE } = require('./client');
const C = { bg: '#EAF6FF', ink: '#29465B', muted: '#7794AA', blue: '#64B5F6', border: '#D6EAF8', white: '#FFFFFF' };
class GameView {
  constructor(platform, client) {
    this.wx = platform; this.client = client;
    this.canvas = platform.createCanvas(); this.ctx = this.canvas.getContext('2d');
    this.buttons = []; this.editing = null; this.animation = null; this.lastMatch = null;
    this.resize();
    platform.onWindowResize?.(() => { this.resize(); this.draw(); });
    platform.onTouchEnd(event => {
      const t = event.changedTouches?.[0]; if (!t) return;
      const x = t.clientX / this.scale - this.left, y = (t.clientY - this.offsetY) / this.scale;
      const b = [...this.buttons].reverse().find(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      if (b) b.action();
    });
    platform.onKeyboardInput(e => this.updateInput(e.value));
    platform.onKeyboardConfirm(e => { this.updateInput(e.value); this.closeKeyboard(); });
    platform.onKeyboardComplete(e => { this.updateInput(e.value); this.editing = null; this.draw(); });
  }
  resize() {
    const i = this.wx.getWindowInfo ? this.wx.getWindowInfo() : this.wx.getSystemInfoSync();
    this.ratio = Math.min(i.pixelRatio || 2, 3); this.width = i.windowWidth; this.height = i.windowHeight;
    this.canvas.width = this.width * this.ratio; this.canvas.height = this.height * this.ratio;
    const top = Math.max(i.safeArea?.top || 0, i.statusBarHeight || 0, 24);
    const bottom = Math.max(16, i.windowHeight - (i.safeArea?.bottom || i.windowHeight));
    this.offsetY = top + 44;
    this.scale = Math.min(this.width / 375, (this.height - this.offsetY - bottom) / 650);
    this.left = (this.width / this.scale - 375) / 2;
  }
  updateInput(value) {
    if (this.editing === 'code') this.client.code = String(value).replace(/\D/g, '').slice(0, 6);
    if (this.editing === 'word') this.client.word = Array.from(String(value)).slice(0, 20).join('');
    this.draw();
  }
  input(kind) {
    if (this.client.busy || this.client.pending) return;
    this.editing = kind;
    this.wx.showKeyboard({ defaultValue: this.client[kind], maxLength: kind === 'code' ? 6 : 40,
      multiple: false, confirmHold: false, confirmType: 'done', keyboardType: kind === 'code' ? 'number' : 'text',
      fail: () => { this.editing = null; this.client.message = '键盘未能打开，请再点一下输入框'; this.draw(); } });
    this.draw();
  }
  closeKeyboard() { this.editing = null; this.wx.hideKeyboard(); this.draw(); }
  round(x, y, w, h, radius = 20, fill = C.white, stroke) {
    const c = this.ctx, r = Math.min(radius, w / 2, h / 2);
    c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1.5; c.stroke(); }
  }
  text(value, x, y, size = 16, color = C.ink, weight = 'normal') {
    const c = this.ctx; c.fillStyle = color; c.font = `${weight} ${size}px sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(value), x, y);
  }
  fit(value, maxWidth, size = 16) {
    this.ctx.font = `${size}px sans-serif`; let result = String(value);
    while (result && this.ctx.measureText(result).width > maxWidth) result = Array.from(result).slice(0, -1).join('');
    return result === String(value) ? result : `${result}…`;
  }
  button(label, y, action, secondary = false, disabled = false, x = 28, w = 319) {
    this.round(x, y, w, 52, 18, disabled ? '#DFEBF3' : secondary ? C.white : C.blue, secondary ? C.border : null);
    this.text(label, x + w / 2, y + 26, 16, disabled ? C.muted : secondary ? C.ink : C.white, 'bold');
    if (!disabled) this.buttons.push({ x, y, w, h: 52, action });
  }
  link(label, y, action, x = 187.5, w = 180) {
    this.text(label, x, y, 14, C.muted); this.buttons.push({ x: x - w / 2, y: y - 24, w, h: 48, action });
  }
  heart(x, y, size, color) {
    const c = this.ctx; c.save(); c.translate(x, y); c.scale(size / 40, size / 40);
    c.beginPath(); c.moveTo(0, 16); c.bezierCurveTo(-40, -8, -17, -34, 0, -17);
    c.bezierCurveTo(17, -34, 40, -8, 0, 16); c.fillStyle = color; c.fill(); c.restore();
  }
  logo(y, progress = 0) {
    this.heart(169 + 12 * progress, y, 45, '#A5D8FA'); this.heart(206 - 12 * progress, y + 5, 45, '#F4ACC5');
    this.text('·', 156, y - 2, 24, C.white); this.text('·', 211, y + 2, 24, C.white);
  }
  background() {
    const c = this.ctx; c.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    c.fillStyle = C.bg; c.fillRect(0, 0, this.width, this.height);
    c.translate(this.left * this.scale, this.offsetY); c.scale(this.scale, this.scale);
    // All background decorations are fixed; only the success hearts animate once.
    this.round(-25, 55, 103, 24, 12, '#F8FCFF'); this.round(-7, 38, 49, 35, 18, '#F8FCFF');
    this.round(304, 490, 104, 25, 13, '#F8FCFF'); this.round(328, 469, 48, 38, 20, '#F8FCFF');
    this.text('✦', 330, 83, 17, '#B7DDF8'); this.text('✦', 39, 539, 13, '#BDDDF4');
  }
  draw() {
    const m = this.client; this.buttons = []; this.background();
    if (!m.foreground && this.animation) { cancelAnimationFrame(this.animation); this.animation = null; }
    if (m.page === 'home') this.home(); else if (m.page === 'join') this.join(); else this.room();
    const message = !m.online ? '网络已断开，进度会为你保留' : m.message;
    if (message) {
      this.round(20, 586, 335, 48, 14, '#FFF7FA'); this.text(this.fit(message, 305, 12), 187.5, 601, 12, '#9A607B');
      if (!m.busy && !m.syncing) this.link(m.pending ? '重试并确认操作结果' : '重新连接', 620, () => m.recover());
    } else this.text('两个人的小默契，一点点靠近', 187.5, 620, 12, C.muted);
  }
  home() {
    const m = this.client, blocked = m.busy || m.syncing || !!m.pending;
    this.round(137, 33, 101, 28, 14, '#DAEEFD'); this.text('双人 · 猜词', 187.5, 47, 12, '#689BBE');
    this.logo(129); this.text('心有灵犀', 187.5, 202, 34, C.ink, 'bold');
    this.text('各想一个词，看看是否想到一起', 187.5, 244, 15, C.muted);
    if (LIVE(m.room)) {
      this.button(`继续房间 ${m.room.roomCode}`, 294, () => m.enter(), false, blocked);
      this.text('上次的小默契还在等你', 187.5, 369, 13, C.muted);
    } else {
      this.button(m.busy ? '正在创建…' : m.syncing ? '正在连接…' : '创建房间', 294, () => m.create(), false, blocked);
      this.button('加入房间', 360, () => { m.page = 'join'; m.message = ''; m.changed(); }, true, blocked);
    }
    this.round(28, 451, 319, 101, 22);
    [['01', '邀请搭档'], ['02', '各想一个词'], ['03', '一起揭晓']].forEach((item, i) => {
      const x = 82 + i * 106; this.round(x - 18, 467, 36, 30, 12, '#F3FAFF');
      this.text(item[0], x, 482, 12, '#79B4DC'); this.text(item[1], x, 522, 12);
    });
  }
  join() {
    const m = this.client;
    this.link('‹ 返回', 24, () => { this.closeKeyboard(); m.home(); }, 60, 90);
    if (!this.editing) this.logo(104);
    this.text('找到你的搭档', 187.5, this.editing ? 80 : 174, 27, C.ink, 'bold');
    this.text('输入好友发来的 6 位房间号', 187.5, this.editing ? 118 : 212, 14, C.muted);
    const inputY = this.editing ? 158 : 256;
    for (let i = 0; i < 6; i++) {
      this.round(28 + i * 54, inputY, 48, 62, 14, C.white, this.editing === 'code' ? '#9BCFF3' : C.border);
      this.text(m.code[i] || '·', 52 + i * 54, inputY + 31, 26, m.code[i] ? C.ink : '#C4D8E8', 'bold');
    }
    this.buttons.push({ x: 28, y: inputY - 6, w: 319, h: 74, action: () => this.input('code') });
    this.button(m.busy ? '正在加入…' : '加入房间', inputY + 88, () => { this.closeKeyboard(); m.join(); }, false,
      m.busy || m.syncing || !!m.pending || !/^\d{6}$/.test(m.code));
    if (!this.editing) {
      this.round(28, 438, 319, 92, 20); this.text('小提示', 187.5, 464, 15, C.ink, 'bold');
      this.text('房间只留给你和一位搭档', 187.5, 496, 13, C.muted);
    }
  }
  player(x, y, p, own) {
    const r = this.client.room; this.round(x, y, 149, 129, 20);
    this.round(x + 52, y + 14, 45, 45, 17, own ? '#DDF1FF' : '#FFEAF1');
    this.heart(x + 74, y + 39, 22, own ? '#91CAF0' : '#EDABC2');
    this.text(own ? '我' : '搭档', x + 74, y + 79, 15, C.ink, 'bold');
    let status = !p.present ? '等待加入' : r.status === 'waiting' ? '已加入' : r.status === 'matched' ? (p.ready ? '已准备下一轮' : '默契达成！') : p.submitted ? '已提交' : '正在想词';
    if (p.present && !own && Date.now() - p.lastSeenAt > 120000) status += ' · 可能离线';
    this.text(status, x + 74, y + 108, status.length > 10 ? 10 : 12, C.muted);
  }
  room() {
    const m = this.client, r = m.room;
    if (!r) { m.page = 'home'; this.home(); return; }
    this.link('‹ 首页', 24, () => { this.closeKeyboard(); m.home(); }, 58, 85);
    this.text(`房间 ${r.roomCode}`, 213, 24, 15, C.ink, 'bold');
    this.link('复制', 24, () => this.wx.setClipboardData({ data: r.roomCode }), 328, 60);
    if (!LIVE(r)) {
      this.logo(163); this.text(r.status === 'expired' ? '房间到期啦' : '房间已结束', 187.5, 241, 28, C.ink, 'bold');
      this.text('带着小默契，再开一场吧', 187.5, 286, 15, C.muted); this.button('回到首页', 365, () => m.home()); return;
    }
    if (r.status === 'matched') { this.matched(); return; }
    if (this.editing === 'word') { this.entry(99); return; }
    this.text(r.status === 'waiting' ? '等一个默契搭档' : `第 ${r.round} 轮 · 第 ${r.attempt} 次尝试`, 187.5, 95, 24, C.ink, 'bold');
    this.text(r.status === 'waiting' ? '把房间号发给 TA，一起开始吧' : '不说出口，也许就能想到一起', 187.5, 130, 13, C.muted);
    this.player(28, 164, r.players[r.ownSeat], true); this.player(198, 164, r.players[1 - r.ownSeat], false);
    this.text('♡', 187.5, 223, 18, '#DFABC1');
    if (r.status === 'waiting') {
      this.round(28, 319, 319, 86, 20); this.text(r.roomCode, 187.5, 349, 31, C.ink, 'bold');
      this.text('房间号 · 有效 24 小时', 187.5, 382, 12, C.muted);
      this.button('邀请微信好友', 430, () => this.wx.shareAppMessage(m.shareData()), false, m.busy || !!m.pending);
    } else this.entry(320);
    this.link('退出房间', 549, () => { this.closeKeyboard(); m.leave(); });
    const e = new Date(r.expiresAt);
    this.text(`有效至 ${e.getMonth() + 1}/${e.getDate()} ${String(e.getHours()).padStart(2, '0')}:${String(e.getMinutes()).padStart(2, '0')}`, 187.5, 574, 10, C.muted);
  }
  entry(y) {
    const m = this.client, r = m.room, own = r.players[r.ownSeat];
    const blocked = m.busy || m.syncing || !!m.pending || own.submitted;
    let prompt = own.submitted ? '已提交，等待搭档' : r.players[1 - r.ownSeat].submitted ? '搭档已提交，等你啦' : '想一个词，准备好就提交';
    if (!own.submitted && r.latestEvent?.type === 'mismatch') prompt = '还没有想到一起，再试一次！';
    if (m.pending?.action === 'submitWord') prompt = '正在确认提交结果';
    this.text(prompt, 187.5, y, 14, C.muted);
    this.round(28, y + 23, 319, 65, 17, own.submitted ? '#E1EFF9' : C.white, C.border);
    this.text(own.submitted ? '词语已收好 ♡' : this.fit(m.word || '点这里，写下你的词', 277, 18), 187.5, y + 55, 18, m.word ? C.ink : C.muted);
    if (!blocked) this.buttons.push({ x: 28, y: y + 23, w: 319, h: 65, action: () => this.input('word') });
    this.text(`${Array.from(m.word.trim()).length}/20 · 只去除首尾空格，其余精确匹配`, 187.5, y + 108, 10, C.muted);
    this.button(m.busy ? '正在确认…' : own.submitted ? '等待搭档提交' : '提交我的词', y + 132,
      () => { this.closeKeyboard(); m.submit(); }, false, blocked || !m.word.trim());
  }
  matched() {
    const m = this.client, r = m.room, event = r.latestEvent;
    if (this.lastMatch !== event.id) { this.lastMatch = event.id; this.matchStart = Date.now(); }
    const progress = Math.min(1, (Date.now() - this.matchStart) / 750);
    this.round(23, 75, 329, 455, 28); this.round(128, 100, 119, 27, 14, '#FFF0F6');
    this.text('默契收集成功', 187.5, 114, 12, '#BA7E97'); this.logo(187, 1 - (1 - progress) ** 3);
    this.text('心有灵犀！', 187.5, 257, 30, C.ink, 'bold'); this.text('原来，我们想到了一起', 187.5, 298, 14, C.muted);
    const word = Array.from(event.matchedWord || '');
    const lines = word.length > 10 ? [word.slice(0, 10).join(''), word.slice(10).join('')] : [word.join('')];
    lines.forEach((line, i) => this.text(line, 187.5, 347 + i * 28, word.length > 10 ? 20 : 26, '#C47E9C', 'bold'));
    const ready = r.players[r.ownSeat].ready;
    this.text(ready ? '已准备，等待搭档' : r.players[1 - r.ownSeat].ready ? '搭档已准备好，等你开始下一轮' : `第 ${r.round} 轮 · 第 ${r.attempt} 次就想到一起`, 187.5, 413, 12, C.muted);
    this.button(ready ? '已准备，等待搭档' : '再来一轮', 448, () => m.ready(), false,
      ready || m.busy || m.syncing || !!m.pending, 44, 287); this.link('退出房间', 552, () => m.leave());
    if (progress < 1 && m.foreground && !this.animation) this.animation = requestAnimationFrame(() => { this.animation = null; this.draw(); });
  }
}
module.exports = { GameView };
