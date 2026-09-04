'use strict';
/* Regression test for the 3-strike hook / team-loss mechanic.
 * Loads server.js in a shared vm context (stubbed I/O) and asserts, using the
 * server's OWN module scope, that checkMatchEnd ends the game as an INSTANT
 * KILLER WIN the moment a survivor is hooked a 3rd time — even if survivors are
 * still alive / mid-escape. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');

let fail = 0;
const ok = (n, c, d) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (d ? '  [' + d + ']' : '')); if (!c) fail++; };

function stubModule(requested) {
  if (requested === 'http') return { createServer: () => ({ listen() {}, close() {} }) };
  if (requested === 'https') return { request: () => ({ on() { return this; }, write() {}, end() {} }) };
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
  process: { env: { NODE_ENV: 'development', ADMIN_TOKEN: 't', PORT: '0' }, on: () => {}, exit: () => {} },
  console: { log(){}, warn(){}, error(){} },
  setInterval: () => 0, setTimeout: () => 0, clearInterval: () => 0, clearTimeout: () => 0,
  Buffer, Date, Math, JSON, __dirname: path.join(__dirname, '..', 'server'),
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'server.js' });

// Run scenarios inside the module's own scope so `players` / `checkMatchEnd`
// resolve to the real bindings (module `const`s aren't globals across runs).
const run = (code) => vm.runInContext(code, sandbox);

const out = run(`
(function(){
  const out = {};
  const killer = { id:'k0', name:'K', role:'killer', state:'match', bot:true, stats:{} };
  const esc = { id:'s0', name:'A', status:'escaped', escaped:true, state:'match', bot:true, stats:{} };
  const alive = { id:'s1', name:'B', status:'injured', escaped:false, state:'match', bot:true, stats:{} };
  players.set(killer.id, killer); players.set(esc.id, esc); players.set(alive.id, alive);

  const match = { id:'M9', state:'running', survivorsEscaped:['A'], killerKills:1,
    survivors:[esc, alive], killer, tripleHook:true, sacrifices:[], t:100, mapId:null,
    players:[esc, alive, killer] };
  checkMatchEnd(match);
  out.triple = { state: match.state, winner: match.result && match.result.winner,
    killerGone: !players.has(match.killer.id) || match.killer.state !== 'match' };

  const m2k = { id:'k1', name:'K2', role:'killer', state:'match', bot:true, stats:{} };
  players.set(m2k.id, m2k);
  const m2 = { id:'M10', state:'running', survivorsEscaped:[], killerKills:1,
    survivors:[], killer:m2k, tripleHook:false, sacrifices:[], t:100, mapId:null, players:[m2k] };
  checkMatchEnd(m2);
  out.nontriple = { winner: m2.result && m2.result.winner };

  return out;
})()
`);

const triple = out.triple || {};
ok('tripleHook ends the match', triple.state === 'done', 'state=' + triple.state);
ok('killer wins on triple hook (regardless of escapes)', triple.winner === 'killer', 'winner=' + triple.winner);
const nt = out.nontriple || {};
ok('non-triple match scores normally (draw here)', nt.winner === 'draw', 'winner=' + nt.winner);
console.log('  triple: ' + JSON.stringify(triple) + ' | non-triple: ' + JSON.stringify(nt));

console.log(fail === 0 ? '\nHOOK3 TEST OK' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);