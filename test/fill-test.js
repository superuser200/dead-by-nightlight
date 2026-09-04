'use strict';
/* Regression test: when a real player leaves a running match, fillReplacementBot
 * inserts a same-role bot into the match roster and the global players Map. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');

let fail = 0;
const ok = (n, c, d) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  [' + d + ']' : '')); if (!c) fail++; };

function stubModule(requested) {
  if (requested === 'http') return { createServer: () => ({ listen() {}, close() {} }) };
  if (requested === 'ws') return { WebSocketServer: function () { this.on = function(){}; } };
  if (requested === 'crypto') return { randomBytes: () => Buffer.alloc(8), createHash: () => ({ update() { return this; }, digest() { return 'x'; } }) };
  if (requested === 'path') return path;
  if (requested === 'fs') return {
    existsSync: () => true, readFileSync: () => '{}', writeFileSync: () => {},
    writeFile: (p, d, cb) => { if (cb) cb(); }, mkdirSync: () => {}, appendFile: () => {}, readdirSync: () => [],
  };
  throw new Error('unexpected require: ' + requested);
}

const sandbox = {
  require: stubModule,
  process: { env: { NODE_ENV: 'production', ADMIN_TOKEN: 't', PORT: '0' }, on: () => {}, exit: () => {} },
  console: { log(){}, warn(){}, error(){} },
  setInterval: () => 0, setTimeout: () => 0, clearInterval: () => 0, clearTimeout: () => 0,
  Buffer, Date, Math, JSON, __dirname: path.join(__dirname, '..', 'server'),
};
const ctx = vm.createContext(sandbox);
vm.runInContext(src, ctx, { filename: 'server.js' });

const out = vm.runInContext(`
(function(){
  const out = {};
  const killer = { id:'qk', name:'QQ', role:'killer', state:'match', bot:false, x:0, z:0, stats:{} };
  const sur = { id:'qs', name:'QQ2', role:'survivor', state:'match', bot:false, x:5, z:5, stats:{} };
  players.set(killer.id, killer); players.set(sur.id, sur);
  const match = {
    id:'M1', state:'running', killer, survivors:[sur], players:[killer, sur],
    gates:[{id:'A',x:0,z:43.8,dir:'north',open:false}], walls:[],
    gatesPowered:false, gensReady:false,
  };
  const before = players.size;

  fillReplacementBot(match, 'survivor', { x: killer.x, z: killer.z });
  const sv = match.survivors.filter(x => x.bot);
  const inPlayers = match.players.filter(x => x.bot);
  const inGlobal = match.survivors.filter(b => b.bot && players.has(b.id));
  out.survivor = {
    added: sv.length, inPlayers: inPlayers.length,
    role: sv[0] && sv[0].role, state: sv[0] && sv[0].state,
    matchId: sv[0] && sv[0].matchId, sizeGrew: players.size === before + 1,
    inGlobal: inGlobal.length,
  };

  const before2 = players.size;
  fillReplacementBot(match, 'killer', null);
  out.killer = {
    replaced: !!match.killer && match.killer.bot,
    role: match.killer && match.killer.role,
    sizeGrew: players.size === before2 + 1,
    inPlayers: match.players.filter(x => x.bot && x.role === 'killer').length,
  };
  return out;
})()
`, ctx);

const s = out.survivor || {};
ok('survivor bot added to match roster', s.added === 1, 'sv=' + s.added);
ok('survivor bot in match.players', s.inPlayers === 1);
ok('survivor bot has correct role/state/matchId', s.role === 'survivor' && s.state === 'match' && s.matchId === 'M1');
ok('survivor bot registered in global players', s.inGlobal === 1 && s.sizeGrew === true);

const k = out.killer || {};
ok('killer bot replaces departed killer', k.replaced === true, 'role=' + k.role);
ok('killer bot in match.players', k.inPlayers === 1);
ok('killer bot registered in global players', k.sizeGrew === true);

console.log('  survivor-fill: ' + JSON.stringify(s));
console.log('  killer-fill:  ' + JSON.stringify(k));
console.log(fail === 0 ? '\nFILL TEST OK' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);