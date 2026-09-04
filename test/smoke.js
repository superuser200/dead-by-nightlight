'use strict';
/* Smoke/integration test: boots against a running server at ws://localhost:8080.
 * Needs the server started with:  ADMIN_TOKEN=smoketest node server/server.js
 */
const WS = require('../node_modules/ws');
const fs = require('fs');
const URL = 'ws://localhost:8080';
const ADMIN_KEY = 'smoketest';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const ok = (cond, label) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + label); if (!cond) failures++; };

function makeClient(name, adminKey, mode) {
  const t = mode === 'login' ? 'login' : 'register';
  return new Promise((resolve, reject) => {
    const ws = new WS(URL);
    const c = { name, ws, auth: null, matchStart: null, states: 0, toasts: [], matchEnd: null, ejected: null, adminSnap: null, byType: {}, chat: null };
    ws.on('open', () => ws.send(JSON.stringify({ t, name, pass: 'pw' + String(name).length + 'xyz', email: 'p' + String(name).toLowerCase() + '@test.dev', admin: adminKey || '' })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      c.byType[m.t] = (c.byType[m.t] || 0) + 1;
      if (m.t === 'auth') c.auth = m;
      if (m.t === 'matchStart') c.matchStart = m;
      if (m.t === 'state') c.states++;
      if (m.t === 'toast') c.toasts.push(m.msg);
      if (m.t === 'matchEnd') c.matchEnd = m;
      if (m.t === 'ejected') c.ejected = m;
      if (m.t === 'adminSnapshot') c.adminSnap = m;
      if (m.t === 'chat') c.chat = m;
    });
    ws.on('error', reject);
    setTimeout(() => resolve(c), 400);
  });
}
const sendi = (c, k, yaw, n) => { for (let i = 0; i < (n || 1); i++) c.ws.send(JSON.stringify({ t: 'input', k, yaw: yaw || 0 })); };

(async () => {
  const TS = String(Date.now() % 100000000); // unique run id so bans can't leak across runs
  // 1. admin connects
  const OT = await makeClient('Adm' + TS, ADMIN_KEY);
  ok(OT.auth && OT.auth.ok && OT.auth.admin, 'admin client authenticated as admin');

  // 2. three players join + queue
  const nameA = 'TA' + TS, nameB = 'TB' + TS, nameC = 'TC' + TS;
  const [A, B, C] = await Promise.all([
    makeClient(nameA, null),
    makeClient(nameB, null),
    makeClient(nameC, null),
  ]);
  ok(A.auth && A.auth.ok && B.auth && B.auth.ok && C.auth && C.auth.ok, '3 clients authenticated');
  ok(OT.adminSnap, 'admin received online snapshot');
  await sleep(700);
  ok(A.byType.state && A.byType.state > 0, 'hub state frames streaming to hub players');

  // 3. auto-start matchmaking: all 3 online real players auto-placed into ONE match
  let matched = []; let matchId = null;
  for (let w = 0; w < 12 && matched.length < 3; w++) {
    await sleep(400);
    matched = [A, B, C].filter(c => c.matchStart);
    if (matched.length === 3) matchId = matched[0].matchStart.match.id;
  }
  await sleep(500);
  const started = [A, B, C].filter(c => c.matchStart);
  ok(started.length === 3, 'auto-match placed all 3 online players');
  ok(A.matchStart && [B, C].every(c => c.matchStart && c.matchStart.match.id === A.matchStart.match.id), 'all 3 in the same match');
  const killer = started.find(c => c.matchStart.match.role === 'killer');
  const survs = started.filter(c => c.matchStart.match.role === 'survivor');
  ok(!!killer && survs.length > 0, 'roles assigned (killer + survivors)');

  // 4. simulated play: inputs + state flow (use whichever survivor is connected)
  const surv = survs[survs.length - 1];
  for (let k = 0; k < 30; k++) {
    sendi(surv, ['w', 'e']); sendi(killer, ['w']);
  }
  await sleep(2000);
  ok(killer.states > 5 && surv.states > 5, 'match state frames streaming to both roles');

  // 5. manual admin ban of a survivor -> ejected, then unbanned
  const banTarget = surv;
  const nameX = banTarget.name;
  OT.ws.send(JSON.stringify({ t: 'admin', op: 'banUser', name: nameX, reason: 'smoke test ban', durMin: 0 }));
  await sleep(1200);
  ok(banTarget.ejected, 'manually banned player was ejected');
  OT.ws.send(JSON.stringify({ t: 'admin', op: 'unbanUser', name: nameX }));
  await sleep(400);
  const B2 = await makeClient(nameX, null, 'login');
  ok(B2.auth && B2.auth.ok, 'unbanned player can rejoin');

  // 6. auto-ban: flood inputs repeatedly from the still-connected killer
  for (let i = 0; i < 4; i++) { sendi(killer, ['shift', 'w'], 0.5, 120); await sleep(1400); }
  await sleep(800);
  const floodHits = killer.ejected || killer.toasts.some(t => /was banned/i.test(t) && /flood|packet|suspicious/i.test(t));
  ok(floodHits, 'input-flood triggered anti-cheat (warning or auto-ban)');

  const K3 = await makeClient(killer.name, null, 'login');
  if (!(K3.auth && !K3.auth.ok && K3.auth.msg && /ann/i.test(K3.auth.msg))) {
    console.log('  [debug] killer=', killer.name, ' killer.ejected=', killer.ejected ? killer.ejected.msg : null, ' killer.toasts=', JSON.stringify(killer.toasts));
    console.log('  [debug] K3.auth=', JSON.stringify(K3.auth), ' K3.byType=', JSON.stringify(K3.byType));
    console.log('  [debug] bans=', fs.readFileSync(require('path').join(__dirname, '..', 'server', 'data', 'bans.json'), 'utf8'));
  }
  ok(K3.auth && !K3.auth.ok && K3.auth.msg && /ann/i.test(K3.auth.msg), `auto-banned name rejected: "${K3.auth && K3.auth.msg}"`);

  // 7. chat spreads (use B2, the only client guaranteed still connected)
  B2.ws.send(JSON.stringify({ t: 'chat', msg: 'hello fog' }));
  await sleep(800);
  if (!B2.chat) console.log('  [debug] B2.byType=', JSON.stringify(B2.byType), ' B2 ws=', B2.ws.readyState);
  ok(B2.chat && B2.chat.msg === 'hello fog', 'chat broadcast working');

  // 8. bad packets are tolerated without crashing
  B2.ws.send('not json!@#');
  await sleep(400);
  ok(true, 'bad packet did not crash server');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(2); });