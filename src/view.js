'use strict';
const { LIVE } = require('./client');
const C = { bg: '#EAF6FF', ink: '#29465B', muted: '#7794AA', blue: '#64B5F6', border: '#D6EAF8', white: '#FFFFFF' };
class GameView {
  constructor(platform, client) {
    this.wx = platform; this.client = client;
    this.canvas = platform.createCanvas(); this.ctx = this.canvas.getContext('2d');
    this.buttons = []; this.editing = null; this.animation = null; this.lastMatch = null;
    this.scrollY = 0; this.maxScroll = 0; this.contentOffset = 0; this.images = new Map();
    this.privacyResolvers = [];
    platform.onNeedPrivacyAuthorization?.(resolve => {
      this.privacyResolvers.push(resolve); this.privacyError = ''; this.draw();
      resolve({ event: 'exposureAuthorization' });
    });
    this.resize();
    platform.onWindowResize?.(() => { this.resize(); this.draw(); });
    platform.onHide?.(() => this.profileButton?.hide());
    platform.onTouchStart?.(event => {
      const t = event.touches?.[0]; if (!t) return;
      this.touch = { y: t.clientY, start: t.clientY, scroll: this.scrollY, moved: false };
    });
    platform.onTouchMove?.(event => {
      const t = event.touches?.[0];
      if (!t || !this.touch || this.client.page !== 'room' || this.editing || this.privacyResolvers.length) return;
      if (Math.abs(t.clientY - this.touch.start) > 8) this.touch.moved = true;
      if (!this.touch.moved) return;
      this.scrollY = Math.max(0, Math.min(this.maxScroll, this.touch.scroll + (this.touch.start - t.clientY) / this.scale)); this.draw();
    });
    platform.onTouchEnd(event => {
      if (this.touch?.moved) { this.touch = null; return; } this.touch = null;
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
    if (this.editing === 'nickname') this.client.profileDraft.nickname = Array.from(String(value)).slice(0, 16).join('');
    this.draw();
  }
  input(kind) {
    if (this.client.busy || this.client.pending) return;
    this.editing = kind;
    this.wx.showKeyboard({ defaultValue: kind === 'nickname' ? this.client.profileDraft.nickname : this.client[kind], maxLength: kind === 'code' ? 6 : kind === 'nickname' ? 32 : 40,
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
    if (!disabled) this.hit(x, y, w, 52, action);
  }
  hit(x, y, w, h, action) {
    const top = y + this.contentOffset, bottom = top + h;
    if (this.contentOffset || this.inContent) {
      if (bottom < 56 || top > 580) return;
      this.buttons.push({ x, y: Math.max(56, top), w, h: Math.min(580, bottom) - Math.max(56, top), action });
    } else this.buttons.push({ x, y, w, h, action });
  }
  link(label, y, action, x = 187.5, w = 180) {
    this.text(label, x, y, 14, C.muted); this.hit(x - w / 2, y - 24, w, 48, action);
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
    const m = this.client; this.buttons = []; this.contentOffset = 0; this.inContent = false; this.background();
    const key = `${m.page}:${m.room?.roomId}:${m.room?.latestEvent?.id}:${m.room?.status}`;
    if (this.pageKey !== key) { this.pageKey = key; this.scrollY = 0; }
    if (!m.foreground && this.animation) { cancelAnimationFrame(this.animation); this.animation = null; }
    if (m.page !== 'profile' || !m.foreground) this.profileButton?.hide();
    if (m.page === 'home') this.home(); else if (m.page === 'join') this.join(); else if (m.page === 'profile') this.profile(); else this.room();
    const message = !m.online ? '网络已断开，进度会为你保留' : m.message;
    if (message) {
      this.round(20, 586, 335, 48, 14, '#FFF7FA'); this.text(this.fit(message, 305, 12), 187.5, 601, 12, '#9A607B');
      if (!m.busy && !m.syncing) this.link(m.pending ? '重试并确认操作结果' : '重新连接', 620, () => m.recover());
    } else this.text('两个人的小默契，一点点靠近', 187.5, 620, 12, C.muted);
    if (this.privacyResolvers.length) this.privacy();
  }
  home() {
    const m = this.client, blocked = m.busy || m.syncing || !!m.pending;
    this.round(137, 33, 101, 28, 14, '#DAEEFD'); this.text('双人 · 猜词', 187.5, 47, 12, '#689BBE');
    this.logo(129); this.text('灵词同契', 187.5, 202, 34, C.ink, 'bold');
    this.text('各想一个词，看看是否想到一起', 187.5, 244, 15, C.muted);
    this.link(m.profile.nickname ? `${this.fit(m.profile.nickname, 160, 14)} · 修改头像昵称` : '设置我的头像和昵称', 423, () => m.editProfile(), 187.5, 319);
    if (LIVE(m.room)) {
      this.button(`继续房间 ${m.room.roomCode}`, 294, () => m.enter(), false, blocked);
      this.button('退出房间，返回大厅', 360, () => m.leave(), true, blocked);
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
    this.hit(28, inputY - 6, 319, 74, () => this.input('code'));
    this.button(m.busy ? '正在加入…' : '加入房间', inputY + 88, () => { this.closeKeyboard(); m.join(); }, false,
      m.busy || m.syncing || !!m.pending || !/^\d{6}$/.test(m.code));
    if (!this.editing) {
      this.round(28, 438, 319, 92, 20); this.text('小提示', 187.5, 464, 15, C.ink, 'bold');
      this.text('房间只留给你和一位搭档', 187.5, 496, 13, C.muted);
    }
  }
  player(x, y, p, own) {
    const r = this.client.room; this.round(x, y, 149, 129, 20);
    this.avatar(x + 52, y + 14, 45, p.profile, own);
    this.text(this.fit(p.profile?.nickname || (own ? '我 · 点头像设置' : '搭档'), 130, 14), x + 74, y + 79, 14, C.ink, 'bold');
    if (own) this.hit(x, y, 149, 94, () => this.client.editProfile());
    let status = !p.present ? '等待加入' : r.status === 'waiting' ? '已加入' : ['matched', 'revealed'].includes(r.status) ? (p.ready ? '已准备继续' : '词语已揭晓') : p.submitted ? '已提交' : '正在想词';
    if (p.present && !own && Date.now() - p.lastSeenAt > 120000) status += ' · 可能离线';
    this.text(status, x + 74, y + 108, status.length > 10 ? 10 : 12, C.muted);
  }
  room() {
    const m = this.client, r = m.room;
    if (!r) { m.page = 'home'; this.home(); return; }
    this.link('‹ 大厅', 24, () => { this.closeKeyboard(); m.home(); }, 48, 76);
    this.link(`房间 ${r.roomCode} · 复制`, 24, () => this.wx.setClipboardData({ data: r.roomCode }), 187.5, 174);
    if (LIVE(r)) this.link('退出房间', 24, () => { this.closeKeyboard(); m.leave(); }, 325, 96);
    if (!LIVE(r)) {
      this.logo(163); this.text(r.status === 'expired' ? '房间到期啦' : '房间已结束', 187.5, 241, 28, C.ink, 'bold');
      this.text('带着小默契，再开一场吧', 187.5, 286, 15, C.muted); this.button('回到首页', 365, () => m.home()); return;
    }
    if (this.editing === 'word') { this.entry(99); return; }
    const c = this.ctx; c.save(); c.beginPath(); c.rect(0, 56, 375, 524); c.clip(); c.translate(0, -this.scrollY);
    this.contentOffset = -this.scrollY; this.inContent = true;
    if (['matched', 'revealed'].includes(r.status)) this.revealed(); else this.playing();
    const end = this.history(550);
    this.link('退出房间', end + 28, () => { this.closeKeyboard(); m.leave(); });
    const e = new Date(r.expiresAt);
    this.text(`有效至 ${e.getMonth() + 1}/${e.getDate()} ${String(e.getHours()).padStart(2, '0')}:${String(e.getMinutes()).padStart(2, '0')}`, 187.5, end + 56, 10, C.muted);
    this.maxScroll = Math.max(0, end + 82 - 580); this.contentOffset = 0; this.inContent = false; c.restore();
    if (this.maxScroll > 0) { this.round(368, 66 + 490 * this.scrollY / (this.maxScroll + 524), 3, Math.max(18, 490 * 524 / (this.maxScroll + 524)), 2, '#B8D6EB'); }
  }
  playing() {
    const m = this.client, r = m.room;
    this.text(r.status === 'waiting' ? '等一个默契搭档' : `第 ${r.round} 轮 · 第 ${r.attempt} 次尝试`, 187.5, 95, 24, C.ink, 'bold');
    this.text(r.status === 'waiting' ? '把房间号发给 TA，一起开始吧' : '不说出口，也许就能想到一起', 187.5, 130, 13, C.muted);
    this.player(28, 164, r.players[r.ownSeat], true); this.player(198, 164, r.players[1 - r.ownSeat], false);
    this.text('♡', 187.5, 223, 18, '#DFABC1');
    if (r.status === 'waiting') {
      this.round(28, 319, 319, 86, 20); this.text(r.roomCode, 187.5, 349, 31, C.ink, 'bold');
      this.text('房间号 · 有效 24 小时', 187.5, 382, 12, C.muted);
      this.button('邀请微信好友', 430, () => this.wx.shareAppMessage(m.shareData()), false, m.busy || !!m.pending);
    } else this.entry(320);
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
    if (!blocked) this.hit(28, y + 23, 319, 65, () => this.input('word'));
    this.text(`${Array.from(m.word.trim()).length}/20 · 只去除首尾空格，其余精确匹配`, 187.5, y + 108, 10, C.muted);
    this.button(m.busy ? '正在确认…' : own.submitted ? '等待搭档提交' : '提交我的词', y + 132,
      () => { this.closeKeyboard(); m.submit(); }, false, blocked || !m.word.trim());
  }
  revealed() {
    const m = this.client, r = m.room, event = r.latestEvent, matched = r.status === 'matched';
    if (this.lastMatch !== event.id) { this.lastMatch = event.id; this.matchStart = Date.now(); }
    const progress = Math.min(1, (Date.now() - this.matchStart) / 750);
    this.logo(103, matched ? 1 - (1 - progress) ** 3 : 0);
    this.text(matched ? '灵词同契！' : '这一刻，各有所想', 187.5, 151, 27, C.ink, 'bold');
    this.text(`第 ${r.round} 轮 · 第 ${r.attempt} 次尝试 · 双方词语已公开`, 187.5, 185, 12, C.muted);
    this.player(28, 214, r.players[r.ownSeat], true); this.player(198, 214, r.players[1 - r.ownSeat], false);
    const words = event.words || [event.matchedWord || '旧版本未记录', event.matchedWord || '旧版本未记录'];
    [r.ownSeat, 1 - r.ownSeat].forEach((seat, i) => {
      this.round(28 + i * 170, 353, 149, 63, 16, matched ? '#FFF1F7' : C.white);
      this.wordLines(words[seat], 102 + i * 170, 385, 16, 130);
    });
    const ready = r.players[r.ownSeat].ready;
    this.text(ready ? '已准备，等搭档一起继续' : '看看彼此的词，再一起向默契靠近', 187.5, 439, 12, C.muted);
    this.button(ready ? '已准备，等待搭档' : matched ? '再来一轮' : '看过了，继续猜词', 467, () => m.ready(), false,
      ready || m.busy || m.syncing || !!m.pending);
    if (matched && progress < 1 && m.foreground && !this.animation) this.animation = requestAnimationFrame(() => { this.animation = null; this.draw(); });
  }
  wordLines(word, x, y, size, width) {
    const chars = Array.from(word || ''), lines = []; let line = '';
    this.ctx.font = `${size}px sans-serif`;
    for (const char of chars) {
      if (line && this.ctx.measureText(line + char).width > width) { lines.push(line); line = ''; }
      line += char;
    }
    lines.push(line);
    lines.forEach((text, i) => this.text(text, x, y + (i - (lines.length - 1) / 2) * (size + 4), size, '#A86E8B', 'bold'));
  }
  history(y) {
    const m = this.client, r = m.room;
    this.text('我们的猜词足迹 · 向上滑动查看', 187.5, y, 14, C.ink, 'bold'); y += 27;
    if (!m.history.length) { this.text('双方提交后，词语会一直留在这里', 187.5, y + 15, 12, C.muted); y += 48; }
    for (const e of m.history) {
      this.round(28, y, 319, 153, 19);
      this.text(`第 ${e.round} 轮 · 第 ${e.attempt} 次 ${e.type === 'matched' ? '♡ 想到一起' : '· 继续靠近'}`, 187.5, y + 23, 12, C.muted);
      const words = e.words || [e.matchedWord || '旧版本未记录', e.matchedWord || '旧版本未记录'];
      [r.ownSeat, 1 - r.ownSeat].forEach((seat, i) => {
        this.text(this.fit(r.players[seat].profile?.nickname || (seat === r.ownSeat ? '我' : '搭档'), 130, 12), 106 + 162 * i, y + 54, 12);
        this.wordLines(words[seat], 106 + 162 * i, y + 105, 13, 133);
      });
      y += 165;
    }
    if (m.historyMore || m.historyMessage) {
      this.link(m.historyBusy ? '正在加载…' : m.historyMessage || '查看更早的记录', y + 16, () => m.loadHistory(), 187.5, 319); y += 48;
    }
    return y;
  }
  avatar(x, y, size, profile, own = true) {
    this.round(x, y, size, size, size * .35, own ? '#DDF1FF' : '#FFEAF1');
    const source = profile?.avatar;
    if (source && !this.images.has(source)) {
      const img = this.wx.createImage(); const entry = { img, loaded: false }; this.images.set(source, entry);
      img.onload = () => { entry.loaded = true; this.draw(); }; img.onerror = () => { entry.failed = true; }; img.src = source;
      if (this.images.size > 12) this.images.delete(this.images.keys().next().value);
    }
    const entry = this.images.get(source);
    if (entry?.loaded) {
      const c = this.ctx; c.save(); this.round(x, y, size, size, size * .35, null); c.clip(); c.drawImage(entry.img, x, y, size, size); c.restore();
    } else this.heart(x + size / 2, y + size * .56, size * .5, own ? '#91CAF0' : '#EDABC2');
  }
  profile() {
    const m = this.client, p = m.profileDraft || m.profile;
    if (!m.profileReady && !p.wechatAuthorized) {
      this.logo(127);
      this.text('先认识一下你', 187.5, 210, 28, C.ink, 'bold');
      this.text('授权微信头像和昵称后进入大厅', 187.5, 259, 15, C.muted);
      this.text('头像和昵称会向房间中的搭档展示', 187.5, 294, 12, C.muted);
      this.ensureProfileButton();
      this.text('暂不授权时，将停留在此页面', 187.5, 456, 12, C.muted);
      return;
    }
    this.link('‹ 返回', 24, () => { this.closeKeyboard(); m.page = m.profileReturn || 'home'; m.message = ''; m.changed(); }, 60, 90);
    this.text('让搭档认出你', 187.5, 83, 27, C.ink, 'bold');
    this.avatar(148, 121, 79, p);
    this.link('选择自己的头像', 229, () => this.chooseAvatar());
    this.round(28, 265, 319, 56, 17, C.white, C.border);
    this.text(this.fit(p.nickname || '点这里，写下昵称', 285, 17), 187.5, 293, 17, p.nickname ? C.ink : C.muted);
    this.hit(28, 265, 319, 56, () => this.requestProfilePrivacy(() => this.input('nickname')));
    this.text('昵称最多 16 个字', 187.5, 342, 11, C.muted);
    this.ensureProfileButton();
    this.button('保存头像和昵称', 444, () => { this.closeKeyboard(); this.requestProfilePrivacy(() => m.saveProfile()); }, false, m.busy || m.syncing || !!m.pending || !p.nickname.trim());
    this.text('保存后会与当前及以后房间的搭档共享', 187.5, 527, 12, C.muted);
  }
  ensureProfileButton() {
    const m = this.client;
    if (!this.wx.createUserInfoButton) { this.text(m.profileReady ? '可选择头像，并手动填写昵称' : '请升级微信后重新进入并授权', 187.5, 391, 13, C.muted); return; }
    const style = { left: (this.left + 28) * this.scale, top: this.offsetY + 365 * this.scale, width: 319 * this.scale, height: 52 * this.scale,
      backgroundColor: '#FFFFFF', color: C.ink, fontSize: 15 * this.scale, lineHeight: 52 * this.scale, textAlign: 'center', borderRadius: 18 * this.scale };
    try {
      if (!this.profileButton) {
        this.profileButton = this.wx.createUserInfoButton({ type: 'text', text: '使用我的微信头像和昵称', style, withCredentials: false });
        this.profileButton.onTap(result => {
          if (m.page !== 'profile' || m.busy || m.pending) return;
          if (result.userInfo) {
            m.profileDraft = { nickname: Array.from(result.userInfo.nickName || '').slice(0, 16).join(''), avatar: (result.userInfo.avatarUrl || '').replace(/^http:\/\//, 'https://'), wechatAuthorized: true };
            if (!m.profileDraft.nickname || !m.profileDraft.avatar) {
              m.profileDraft.wechatAuthorized = false; m.message = '未取得完整微信头像昵称，请重新授权';
            } else if (!m.profileReady) { m.saveProfile(); return; }
            else m.message = '已导入，点击保存后搭档可见';
          } else m.message = '请授权微信头像和昵称后再进入游戏';
          m.changed();
        });
      } else Object.assign(this.profileButton.style, style);
      if (m.foreground && !this.editing && !m.busy && !m.pending && !this.privacyResolvers.length) this.profileButton.show(); else this.profileButton.hide();
    } catch (_) { this.text(m.profileReady ? '可选择头像，并手动填写昵称' : '微信授权暂不可用，请重新进入', 187.5, 391, 13, C.muted); }
  }
  chooseAvatar() {
    this.requestProfilePrivacy(() => this.pickAvatar());
  }
  requestProfilePrivacy(action) {
    if (this.client.busy || this.client.pending || this.client.syncing) return;
    if (!this.wx.requirePrivacyAuthorize) { action(); return; }
    this.wx.requirePrivacyAuthorize({
      success: () => { if (this.client.page === 'profile') action(); },
      fail: () => { this.client.message = this.client.profileReady ? '资料未修改' : '请先授权微信头像和昵称，再进入游戏'; this.client.changed(); }
    });
  }
  privacy() {
    this.profileButton?.hide(); this.buttons = [];
    const c = this.ctx; c.fillStyle = 'rgba(41,70,91,.28)'; c.fillRect(-this.left, -this.offsetY / this.scale, this.width / this.scale, this.height / this.scale);
    this.round(23, 159, 329, 340, 27);
    this.text('和搭档认识一下', 187.5, 199, 23, C.ink, 'bold');
    this.text('我们会使用你选择的头像和昵称', 187.5, 247, 14);
    this.text('在双人房间中向彼此展示', 187.5, 275, 14);
    this.text('授权并保存后即可进入游戏大厅', 187.5, 309, 12, C.muted);
    this.link('阅读《隐私保护指引》', 352, () => this.wx.openPrivacyContract?.({
      fail: () => { this.privacyError = '指引暂未打开，请稍后重试'; this.draw(); }
    }), 187.5, 280);
    if (this.privacyError) this.text(this.privacyError, 187.5, 380, 11, '#9A607B');
    this.button('同意并继续', 400, () => this.resolvePrivacy(true), false, false, 44, 287);
    this.link('暂不授权', 476, () => this.resolvePrivacy(false));
  }
  resolvePrivacy(agree) {
    const resolvers = this.privacyResolvers; this.privacyResolvers = []; this.privacyError = '';
    // Called only by a real touch on the agreement or refusal button.
    for (const resolve of resolvers) resolve({ event: agree ? 'agree' : 'disagree' });
    this.draw();
  }
  pickAvatar() {
    const m = this.client;
    if (m.busy || m.pending || m.syncing) return;
    if (!this.wx.chooseMedia) { m.message = '当前微信不支持选图，请使用微信头像导入'; m.changed(); return; }
    this.wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['compressed'],
      success: result => {
        const path = result.tempFiles?.[0]?.tempFilePath; if (!path) return;
        const img = this.wx.createImage();
        img.onload = () => {
          if (m.page !== 'profile') return;
          try {
            const canvas = this.wx.createCanvas(); canvas.width = 96; canvas.height = 96;
            const ctx = canvas.getContext('2d'), size = Math.min(img.width, img.height);
            ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, 96, 96);
            ctx.drawImage(img, (img.width - size) / 2, (img.height - size) / 2, size, size, 0, 0, 96, 96);
            const avatar = canvas.toDataURL('image/jpeg', .75);
            if (!avatar.startsWith('data:image/jpeg;base64,') || avatar.length > 40000) throw new Error('IMAGE');
            m.profileDraft.avatar = avatar; m.message = '头像已选好，保存后搭档可见';
          } catch (_) { m.message = '图片处理失败，请换张图片或导入微信头像'; }
          m.changed();
        };
        img.onerror = () => { m.message = '图片未能打开，请重新选择'; m.changed(); }; img.src = path;
      }, fail: error => {
        if (!/cancel/.test(error.errMsg || '')) {
          console.warn('Avatar selection failed:', error.errMsg || 'UNKNOWN');
          m.message = '选图未完成，可改用微信头像导入'; m.changed();
        }
      }
    });
  }
}
module.exports = { GameView };
