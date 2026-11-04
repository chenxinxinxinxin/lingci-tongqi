'use strict';
wx.cloud.init({ env: 'wordtune-d4gl8hb7gf0d380b7', traceUser: true });
const { GameClient } = require('./src/client');
const { GameView } = require('./src/view');
const client = new GameClient(wx);
const view = new GameView(wx, client);
client.onChange = () => view.draw();
view.draw();
client.start();
