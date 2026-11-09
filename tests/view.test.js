'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GameClient } = require('../src/client');
const { GameView } = require('../src/view');

test('photo selection waits for an actual consent tap and refusal keeps it closed', () => {
  const hooks = {}, reports = []; let photoCalls = 0, pending;
  const ctx = new Proxy({ measureText: text => ({ width: Array.from(text).length * 14 }) }, {
    get: (target, key) => key in target ? target[key] : () => {}
  });
  const wx = {
    createCanvas: () => ({ getContext: () => ctx }),
    createImage: () => ({}),
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 812, safeArea: { top: 44, bottom: 778 } }),
    onNeedPrivacyAuthorization: f => { hooks.privacy = f; }, onTouchEnd: f => { hooks.tap = f; },
    onKeyboardInput() {}, onKeyboardConfirm() {}, onKeyboardComplete() {},
    requirePrivacyAuthorize: callbacks => {
      pending = callbacks;
      hooks.privacy(result => {
        reports.push(result.event);
        if (result.event === 'agree') pending.success();
        if (result.event === 'disagree') pending.fail();
      });
    },
    chooseMedia: () => { photoCalls++; }
  };
  const client = new GameClient(wx);
  client.profile = { nickname: '玩家', avatar: 'https://thirdwx.qlogo.cn/mmopen/test/132', wechatAuthorized: true };
  client.editProfile();
  const view = new GameView(wx, client); client.onChange = () => view.draw(); view.draw();
  const tap = y => hooks.tap({ changedTouches: [{ clientX: (187.5 + view.left) * view.scale, clientY: view.offsetY + y * view.scale }] });
  view.chooseAvatar();
  assert.equal(photoCalls, 0); assert.deepEqual(reports, ['exposureAuthorization']);
  tap(476);
  assert.equal(photoCalls, 0); assert.equal(client.page, 'profile');
  assert.deepEqual(reports, ['exposureAuthorization', 'disagree']);
  view.chooseAvatar(); tap(426);
  assert.equal(photoCalls, 1); assert.equal(reports.at(-1), 'agree');
});

test('first entry offers WeChat authorization and denial cannot open the lobby', () => {
  let onTap, saves = 0; const labels = [];
  const ctx = new Proxy({ measureText: text => ({ width: Array.from(text).length * 14 }), fillText: text => labels.push(text) }, {
    get: (target, key) => key in target ? target[key] : () => {}
  });
  const wx = {
    createCanvas: () => ({ getContext: () => ctx }),
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 812 }),
    onTouchEnd() {}, onKeyboardInput() {}, onKeyboardConfirm() {}, onKeyboardComplete() {},
    createUserInfoButton: () => ({ onTap: callback => { onTap = callback; }, show() {}, hide() {} })
  };
  const client = new GameClient(wx), view = new GameView(wx, client);
  client.onChange = () => view.draw(); client.saveProfile = () => { saves++; };
  view.draw();
  assert.ok(labels.includes('授权微信头像和昵称后进入大厅'));
  assert.ok(!labels.includes('选择自己的头像')); assert.equal(view.buttons.length, 0);
  onTap({ errMsg: 'getUserInfo:fail auth deny' });
  assert.equal(client.page, 'profile'); assert.equal(saves, 0);
  onTap({ userInfo: { nickName: '微信玩家', avatarUrl: 'https://thirdwx.qlogo.cn/mmopen/test/132' } });
  assert.equal(saves, 1); assert.equal(client.profileDraft.wechatAuthorized, true);
});
