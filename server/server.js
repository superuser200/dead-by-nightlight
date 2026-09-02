'use strict';
/* ============================================================================
 * DEAD BY NIGHTLIGHT — MMO game server
 * 1 killer vs 10 survivors, shared hub world, chat, leaderboard, matchmaking,
 * server-authoritative movement (speed/fly/teleport cheats are neutralized),
 * auto-ban cheating detector, and a manual admin ban tool.
 * ==========================================================================*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomBytes, createHash } = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || randomBytes(8).toString('hex');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const TICK_MS = 50;        // 20 Hz match simulation
const HUB_TICK_MS = 66;    // ~15 Hz hub simulation
const MATCHMAKER_MS = 1000;

const FWD = (yaw) => ({ x: Math.sin(yaw), z: -Math.cos(yaw) });
const RIGHT = (yaw) => ({ x: Math.cos(yaw), z: Math.sin(yaw) });
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = () => Math.random();
const rint = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const hShake = (s) => createHash('sha256').update(s).digest('hex');

/* ----------------------------------------------------------------------------
 * Persistence
 * -------------------------------------------------------------------------*/
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

let bans = loadJSON('bans.json', { users: {}, ips: {} });
let stats = loadJSON('stats.json', {});   // name -> {games,esc,ghosted,kills,dead}
let cheatLog = loadJSON('cheatlog.json', []);

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); }
  catch { return fallback; }
}
function save(file, data, pretty) {
  fs.writeFile(path.join(DATA, file), JSON.stringify(data, null, pretty ? 2 : 0), () => {});
}
function logCheat(entry) {
  entry.t = Date.now();
  cheatLog.unshift(entry);
  if (cheatLog.length > 500) cheatLog.length = 500;
  save('cheatlog.json', cheatLog, true);
  broadcastAdmin({ t: 'cheat', entry });
}

/* ----------------------------------------------------------------------------
 * Static file server
 * -------------------------------------------------------------------------*/
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/api/stats') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ online: players.size, stats: topStats(10) }));
    return;
  }
  if (urlPath === '/healthz') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, online: players.size, matches: matches.size }));
    return;
  }
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

/* ----------------------------------------------------------------------------
 * Server state
 * -------------------------------------------------------------------------*/
const players = new Map(); // id -> player  (every connected client)
const config = { hubW: 60, yawOff: 0 };

/* ----------------------------------------------------------------------------
 * WebSocket
 * -------------------------------------------------------------------------*/
const wss = new WebSocketServer({ server });

let idCounter = 1000;
const clientFor = new Map(); // ws -> player

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
             (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

  const p = {
    ws,
    id: String(++idCounter),
    ip,
    name: '',
    nameLow: '',
    admin: false,
    state: 'hub',            // 'hub' | 'match'
    matchId: null,
    role: null,
    queued: false,
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0,
    vy: 0, jumpT: 0,
    keys: new Set(),
    inputBuffer: [],
    lastInputAt: 0,
    flags: { hits: 0, lastWindow: 0, count: 0, badJson: 0 },
    lastChatAt: 0,
    lastPing: 0,
    kickT: 0,                 // disconnect delay when banned
  };
  clientFor.set(ws, p);
  p.ws.on('message', (data) => { try { onMessage(p, data.toString()); } catch (err) { log('MSGERR', 'ws/' + (p.name || p.id), err.message); } });
  p.ws.on('close', () => onClose(p));
  p.ws.on('error', () => onClose(p));
});

/* ----------------------------------------------------------------------------
 * Message handling
 * -------------------------------------------------------------------------*/
function onMessage(p, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
    if (!msg || typeof msg !== 'object') throw new Error('bad');
  } catch {
    p.flags.badJson += 1;
    if (p.flags.badJson >= 5) autoBan(p, 'bad-json flood');
    else if (p.flags.badJson >= 3) kickLater(p, 'invalid packets');
    return;
  }
  switch (msg.t) {
    case 'join': return onJoin(p, msg);
    case 'input': return onInput(p, msg);
    case 'chat': return onChat(p, msg);
    case 'queue': return onQueue(p, true);
    case 'unqueue': return onQueue(p, false);
    case 'admin': return onAdmin(p, msg);
    default:
      p.flags.badJson += 1;
  }
}

function onJoin(p, msg) {
  if (p.name) return;
  const raw = String(msg.name || '').trim();
  if (raw.length < 2 || raw.length > 16 || !/^[\w\u00C0-\u00FF .\-]{2,16}$/.test(raw)) {
    p.ws.send(JSON.stringify({ t: 'auth', ok: false, msg: 'Name must be 2-16 letters/numbers.' }));
    return;
  }
  const nameLow = raw.toLowerCase();
  const now = Date.now();

  // Ban check (user + IP)
  const ub = bans.users[nameLow]; if (ub && (ub.until === 0 || ub.until > now)) {
    p.ws.send(JSON.stringify({ t: 'auth', ok: false, msg: 'Banned: ' + ub.reason })); return;
  }
  const ib = bans.ips[p.ip]; if (ib && (ib.until === 0 || ib.until > now)) {
    p.ws.send(JSON.stringify({ t: 'auth', ok: false, msg: 'Banned: ' + ib.reason })); return;
  }

  p.name = raw;
  p.nameLow = nameLow;
  if (msg.admin && typeof msg.admin === 'string' && hShake(msg.admin) === hShake(ADMIN_TOKEN)) {
    p.admin = true;
  }
  players.set(p.id, p);
  p.x = rint(-20, 20);
  p.z = rint(-20, 20);
  p.yaw = rand() * Math.PI * 2;
  p.stats = stats[nameLow] || { games: 0, esc: 0, dead: 0, kills: 0, wins: 0 };

  p.ws.send(JSON.stringify({
    t: 'auth', ok: true, id: p.id, name: p.name, admin: p.admin, now,
    cfg: { hubW: config.hubW },
  }));
  if (p.admin) sendAdminSnapshot(p);
  broadcastToast(`${p.name} entered the fog.`);
  save('stats.json', stats, true);
}

function onInput(p, msg) {
  if (!p.name) return;
  const now = Date.now();

  // rolling-window flood gate: >60 inputs in any 1s window is suspicious
  const tq = p.flags.times || (p.flags.times = []);
  tq.push(now);
  while (tq.length && tq[0] <= now - 1000) tq.shift();
  if (tq.length > 60) {
    p.flags.hits += 1;
    if (tq.length > 400) tq.splice(0, tq.length - 400);
    logCheat({ name: p.name, ip: p.ip, kind: 'input-flood', rate: tq.length, gw: p.state === 'hub' ? 'hub' : getMatch(p) ? getMatch(p).id : '?' });
    if (p.flags.hits >= 3) autoBan(p, 'packet flood / speed-hack attempt');
    else { tq.length = 0; p.ws.send(JSON.stringify({ t: 'toast', msg: 'Warning: slow down.' })); }
    return;
  }

  if (p.state === 'match' && getMatch(p) && getMatch(p).state === 'done') return;

  // Buffer inputs; server consumes at most one per tick -> flooding cannot speed you up.
  if (Array.isArray(msg.k)) {
    p.inputBuffer.push({ k: msg.k, yaw: Number(msg.yaw) || 0, pitch: Number(msg.pitch) || 0 });
    if (p.inputBuffer.length > 4) p.inputBuffer.splice(0, p.inputBuffer.length - 4);
  }
}

function onChat(p, msg) {
  if (!p.name) return;
  const now = Date.now();
  if (now - p.lastChatAt < 650) return;
  p.lastChatAt = now;
  let text = String(msg.msg || '').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 160);
  if (!text.trim()) return;
  broadcast({ t: 'chat', from: p.name, msg: text.trim(), admin: p.admin });
}

function onQueue(p, queued) {
  if (!p.name) return;
  const target = queued === undefined ? !p.queued : queued;
  if (target === p.queued) return;
  p.queued = target;
  if (target) { if (queue.indexOf(p) < 0) queue.push(p); }
  else { const i = queue.indexOf(p); if (i >= 0) queue.splice(i, 1); }
  p.ws.send(JSON.stringify({ t: 'queue', queued: p.queued, size: queue.length }));
}

/* ----------------------------------------------------------------------------
 * Matchmaking
 * -------------------------------------------------------------------------*/
const queue = []; // player references
const matches = new Map(); // id -> match
let matchIdCounter = 0;

setInterval(() => {
  while (queue.length >= 2) {
    const group = queue.splice(0, 11);
    startMatch(group);
  }
  broadcastQueueInfo();
}, MATCHMAKER_MS);

function broadcastQueueInfo() {
  if (!players.size) return;
  const msg = { t: 'queueInfo', size: queue.length, matches: matches.size };
  for (const p of players.values()) if (p.state === 'hub') send(p, msg);
}

/* ----------------------------------------------------------------------------
 * Match
 * -------------------------------------------------------------------------*/
function startMatch(group) {
  for (const p of group) p.queued = false;
  const killerIdx = Math.floor(rand() * group.length);
  const match = {
    id: 'M' + (++matchIdCounter),
    state: 'running',
    t: 0,
    endT: null,
    result: null,
    gens: makeGens(),
    gates: makeGates(),
    survivorsEscaped: [],
    sacrifices: [],
    gensDone: 0,
    gatesPowered: false,
    killerKills: 0,
  };
  match.players = group;
  match.killer = group[killerIdx];
  match.survivors = group.filter((_, i) => i !== killerIdx);

  const spawns = ringSpawns(group.length);
  group.forEach((p, i) => {
    p.matchId = match.id;
    p.state = 'match';
    p.role = i === killerIdx ? 'killer' : 'survivor';
    const s = spawns[i];
    p.x = s.x; p.z = s.z; p.yaw = Math.atan2(-s.x, s.z); // face center
    p.y = 0; p.vy = 0; p.jumpT = 0; p.keys.clear(); p.inputBuffer.length = 0;
    p.hp = 2;                // survivors only
    p.status = 'alive';
    p.carrier = null;
    p.reviveT = 0;
    p.bleedT = 0;
    p.sprint = 100;          // killer stamina
    p.attackCd = 0;
    p.lungeT = 0;
    p.lastHitAt = 0;
    p.escaped = false;
    p.kills = 0;
    p.sac = 0;
    send(p, { t: 'matchStart', match: { id: match.id, role: p.role, map: matchView(match) } });
  });

  matches.set(match.id, match);
  broadcastToast(`Match ${match.id} started — ${match.killer.name} hunts ${match.survivors.length} survivors.`);
  log('MATCH START', match.id, `${match.killer.name} killer / ${match.survivors.length} survivors`);
}

// map layout — random but stable per match
function makeGens() {
  const gens = [];
  const spots = [];
  for (let i = 0; i < 24; i++) spots.push([rint(-40, 40), rint(-40, 40)]);
  spots.sort((a, b) => (a[0] + a[1] * 3) - (b[0] + b[1] * 3));
  for (let i = 0; i < 6; i++) {
    const s = spots[i];
    gens.push({ id: i, x: s[0], z: s[1], prog: 0, done: false });
  }
  return gens;
}
function makeGates() {
  // Gate A: opening on the north wall, Gate B on the east wall.
  return [
    { id: 'A', x: 0, z: 43.8, dir: 'north', open: false, prog: 0, zone: { rect: { x: -4, z: 43.5, w: 8, d: 2.5 } } },
    { id: 'B', x: 43.8, z: 0, dir: 'east', open: false, prog: 0, zone: { rect: { x: 43.5, z: -4, w: 2.5, d: 8 } } },
  ];
}
function ringSpawns(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand() * 0.5;
    out.push({ x: Math.round(Math.cos(a) * 22 * 100) / 100, z: Math.round(Math.sin(a) * 22 * 100) / 100 });
  }
  return out;
}

const HOOK_LOCS = [
  [-24, -20], [22, -26], [-14, 24], [26, 18], [-34, 30], [34, -30], [0, 0], [-6, -34], [8, 36], [-40, -4], [40, 6], [-18, -6], [16, 6], [-2, 2],
];

function matchView(match) {
  return {
    id: match.id,
    state: match.state,
    w: 90,
    gens: match.gens,
    gates: match.gates,
    hooks: HOOK_LOCS.map(([x, z]) => ({ x, z })),
    gensDone: match.gensDone,
    gatesPowered: match.gatesPowered,
  };
}

function getMatch(p) { return matches.get(p.matchId); }

/* ----------------------------------------------------------------------------
 * Match simulation tick (every 50 ms)
 * -------------------------------------------------------------------------*/
const dt = TICK_MS / 1000;

setInterval(() => {
  try {
    for (const match of matches.values()) {
      if (match.state === 'done') {
        if (match.endT == null) match.endT = Date.now();
        if (Date.now() - match.endT > 6000) {
          for (const p of match.players) if (players.has(p.id)) returnToHub(p);
          matches.delete(match.id);
          continue;
        }
        // during end screen, still move? no, freeze. skip sim.
        broadcastMatch(match);
        continue;
      }
      simulateMatch(match);
      broadcastMatch(match);
      checkMatchEnd(match);
    }
  } catch (err) { log('TICKERR', 'match', err.stack || err.message); }
}, TICK_MS);

function simulateMatch(match) {
  match.t += dt;
  const killer = match.killer;
  const survs = match.survivors;

  // players in match: process input (one buffered input per tick max, so floods can't speed anyone)
  for (const p of match.players) {
    if (!players.has(p.id) || p.state !== 'match') continue;
    const input = p.inputBuffer.shift() || null;
    if (input) { p.keys = new Set(input.k); p.yaw = input.yaw; p.pitch = input.pitch; }
    else p.keys.clear();

    if (p === killer) {
      const sprinting = p.keys.has('shift');
      if (sprinting) p.sprint = Math.max(0, p.sprint - dt * 14);
      else p.sprint = Math.min(100, p.sprint + dt * 30);
      const canSprint = p.sprint > 5 && !p.carrier;
      let speed = p.carrier ? 6.2 : 8.5;
      if (canSprint) speed = 11.5;
      p.lungeT = Math.max(0, p.lungeT - dt);
      p.attackCd = Math.max(0, p.attackCd - dt);
      if (p.keys.has('m1') && p.attackCd <= 0) {
        p.attackCd = 2.2;
        p.lungeT = 0.22;
        doAttack(match, p);
      }
      const lungeMul = p.lungeT > 0 ? 1.7 : 1;
      moveEntity(p, speed * lungeMul, dt);

      // carry / hook / pick drop
      if (p.carrier) {
        const c = players.get(p.carrier);
        if (!c || c.status !== 'downed') p.carrier = null;
        else {
          c.x = p.x; c.z = p.z;
          if (p.keys.has('e')) {
            const nearHook = HOOK_LOCS.some(([hx, hz]) => dist2(c, { x: hx, z: hz }) <= 2.4 * 2.4);
            if (nearHook) {
              killSurvivor(match, c, 'sacrificed', p);
              p.carrier = null;
            }
          }
          if (p.keys.has('space')) {
            p.carrier = null;
            c.bleedT = 45;
          }
        }
      } else if (p.keys.has('e')) {
        const target = survs.find(s => s.status === 'downed' && dist2(s, p) <= 2.2 * 2.2);
        if (target) { p.carrier = target.id; target.bleedT = 0; }
      }
    } else {
      // survivor movement
      if (p.status === 'dead' || p.status === 'escaped') { p.keys.clear(); p.inputBuffer.length = 0; continue; }
      const injured = p.status === 'injured';
      let speed = injured ? 5.3 : 7.0;
      moveEntity(p, speed, dt);
    }
  }

  // --- interactions
  for (const p of survs) {
    if (!players.has(p.id) || p.state !== 'match') continue;
    if (p.status === 'dead' || p.status === 'escaped') { p.bleedT = 0; continue; }

    // bleeding out
    if (p.status === 'downed') {
      p.bleedT -= dt;
      if (p.bleedT <= 0) killSurvivor(match, p, 'bled-out', killer);
      continue;
    }

    const e = p.keys.has('e');

    // repair generators
    if (e && p.status !== 'downed' && p.carrier == null) {
      for (const g of match.gens) {
        if (g.done) continue;
        if (dist2(p, g) <= 2.1 * 2.1) {
          const nearKiller = dist2(p, killer) <= 12 * 12;
          g.prog += dt * (nearKiller ? 0.18 : 0.8);
          g.prog = clamp(g.prog, 0, 1);
          if (g.prog >= 1 && !g.done) {
            g.done = true; match.gensDone += 1;
            if (match.gensDone >= 5) {
              match.gatesPowered = true;
              broadcastToast('The exit gates are powered!');
            }
          }
        }
      }
    }

    // revive downed teammate
    if (e) {
      const target = survs.find(s => s !== p && s.status === 'downed' && dist2(p, s) <= 2 * 2);
      if (target) {
        if (target.reviveT == null) target.reviveT = 0;
        target.reviveT += dt;
        if (target.reviveT >= 5) { target.status = 'injured'; target.reviveT = 0; log('REVIVE', match.id, `${p.name} revived ${target.name}`); }
      } else if (p.reviveT) p.reviveT = 0;
    }

    // open gates / escape
    for (const g of match.gates) if (g.open) {
      if (pointInRect(p, g.zone.rect)) { escapeSurvivor(match, p); break; }
    }
    if (match.gatesPowered && !p.escaped) {
      const gA = match.gates[0], gB = match.gates[1];
      if (e && dist2(p, gA) <= 2.3 * 2.3 && !gA.open) { gA.prog += dt * 0.5; if (gA.prog >= 1) gA.open = true; }
      if (e && dist2(p, gB) <= 2.3 * 2.3 && !gB.open) { gB.prog += dt * 0.5; if (gB.prog >= 1) gB.open = true; }
    }
  }
}

function pointInRect(p, r) {
  return p.x >= r.x && p.x <= r.x + r.w && p.z >= r.z && p.z <= r.z + r.d;
}

function moveEntity(p, speed, dt) {
  let mx = 0, mz = 0;
  if (p.keys.has('w')) { const f = FWD(p.yaw); mx += f.x; mz += f.z; }
  if (p.keys.has('s')) { const f = FWD(p.yaw); mx -= f.x; mz -= f.z; }
  if (p.keys.has('d')) { const r = RIGHT(p.yaw); mx += r.x; mz += r.z; }
  if (p.keys.has('a')) { const r = RIGHT(p.yaw); mx -= r.x; mz -= r.z; }
  const len = Math.hypot(mx, mz);
  if (len > 0) { mx /= len; mz /= len; }

  // jump (server-controlled so fly hacks are impossible)
  p.jumpT = Math.max(0, p.jumpT - dt);
  if (p.keys.has('space') && p.y <= 0.001) { p.vy = 8.5; p.jumpT = 0.05; }
  p.vy -= 20 * dt;
  p.y += p.vy * dt;
  if (p.y <= 0) { p.y = 0; p.vy = 0; }

  const bounds = 45;
  p.x = clamp(p.x + mx * speed * dt, -bounds, bounds);
  p.z = clamp(p.z + mz * speed * dt, -bounds, bounds);
}

function doAttack(match, killer) {
  const now = Date.now();
  if (now - killer.lastHitAt < 250) return;
  killer.lastHitAt = now;
  const facing = FWD(killer.yaw);
  for (const s of match.survivors) {
    if (!players.has(s.id) || s.state !== 'match') continue;
    if (s.status === 'escaped' || s.status === 'dead') continue;
    if (s === killer) continue;
    const dx = s.x - killer.x, dz = s.z - killer.z;
    const d = Math.hypot(dx, dz);
    if (d > 2.7) continue;
    // cone check (facing within ~70 degrees)
    const nx = dx / (d || 1), nz = dz / (d || 1);
    if (nx * facing.x + nz * facing.z < 0.34) continue;
    if (s.status === 'injured') { killSurvivor(match, s, 'downed', killer); }
    else if (s.status === 'alive') {
      s.status = 'injured';
      killer.kills += 1;
      send(killer, { t: 'toast', msg: `You wounded ${s.name}` });
      send(s, { t: 'toast', msg: `${killer.name} wounded you!` });
    }
  }
}

function killSurvivor(match, s, how, killer) {
  if (s.status === 'dead' || s.status === 'escaped') return;
  s.status = 'downed' === how ? 'downed' : 'dead';
  if (how === 'downed') { s.bleedT = 45; s.reviveT = 0; return; }
  s.status = 'dead';
  s.deadBy = killer.name;
  s.bleedT = 0;
  match.sacrifices.push({ id: s.id, name: s.name, how, by: killer.name });
  match.killerKills += 1;
  killer.sac += 1;
  send(s, { t: 'toast', msg: `You were ${how === 'bled-out' ? 'left to bleed out' : 'sacrificed'} by ${killer.name}.` });
  send(killer, { t: 'toast', msg: `${s.name} was sacrificed.` });
  log('KILL', match.id, `${killer.name} -> ${s.name} (${how})`);
}

function escapeSurvivor(match, p) {
  if (p.escaped || p.status === 'dead') return;
  p.escaped = true;
  p.status = 'escaped';
  match.survivorsEscaped.push(p.name);
  p.stats.esc = (p.stats.esc || 0) + 1;
  send(p, { t: 'toast', msg: 'You escaped!' });
  broadcast({ t: 'chat', from: 'FOG', msg: `${p.name} escaped through the gate.`, admin: false });
  log('ESCAPE', match.id, p.name);
}

function checkMatchEnd(match) {
  const aliveorwaiting = match.survivors.filter(s => players.has(s.id) && s.state === 'match' && (s.status === 'alive' || s.status === 'injured' || s.status === 'downed'));
  const killerGone = !players.has(match.killer.id) || match.killer.state !== 'match';
  if (killerGone) {
    // killer disconnected — survivors all escape
    for (const s of match.survivors) if (players.has(s.id) && s.state === 'match' && s.status !== 'dead') escapeSurvivor(match, s);
  }
  if (aliveorwaiting.length === 0 || killerGone) {
    const esc = match.survivorsEscaped.length;
    const k = match.killerKills;
    let winner = 'draw';
    let killerWin = false, survWin = false;
    if (killerGone) survWin = true;
    else {
      if (esc >= 3) survWin = true;
      else if (k >= 3) killerWin = true;
    }
    winner = survWin ? 'survivors' : killerWin ? 'killer' : 'draw';

    for (const s of match.survivors) {
      if (!players.has(s.id)) continue;
      s.stats.games = (s.stats.games || 0) + 1;
      if (survWin) s.stats.wins = (s.stats.wins || 0) + 1;
      if (s.status === 'dead') s.stats.dead = (s.stats.dead || 0) + 1;
    }
    const kk = match.killer;
    if (players.has(kk.id)) {
      kk.stats.games = (kk.stats.games || 0) + 1;
      if (killerWin) kk.stats.wins = (kk.stats.wins || 0) + 1;
      kk.stats.kills = (kk.stats.kills || 0) + k;
    }
    save('stats.json', stats, true);

    match.result = { winner, esc, kills: k, survivors: match.survivors.length, killer: match.killer.name };
    match.state = 'done';
    for (const p of match.players) if (players.has(p.id)) {
      const mine = p === match.killer
        ? { role: 'killer', kills: k, win: killerWin }
        : { role: 'survivor', escaped: p.escaped, dead: p.status === 'dead', win: survWin };
      send(p, { t: 'matchEnd', result: match.result, mine });
    }
    log('END', match.id, `${match.result.winner} (${match.killer.name}) esc=${esc} kills=${k}`);
  }
}

/* ----------------------------------------------------------------------------
 * Hub simulation (small world, everyone see each other -> true MMO feel)
 * -------------------------------------------------------------------------*/
setInterval(() => {
  try {
    const hubs = [];
    for (const p of players.values()) {
      if (p.state !== 'hub' || !p.name) continue;
      const input = p.inputBuffer.shift() || null;
      if (input) { p.keys = new Set(input.k); p.yaw = input.yaw; }
      else p.keys.clear();
      moveEntity(p, 7, HUB_TICK_MS / 1000);
      hubs.push(peerView(p));
    }
    const frame = { type: 'hub', players: hubs };
    for (const p of players.values()) if (p.state === 'hub' && p.name) send(p, { t: 'state', ...frame, you: peerView(p) });
  } catch (err) { log('HUBERR', 'tick', err.stack || err.message); }
}, HUB_TICK_MS);

function peerView(p) {
  return { id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw,
    admin: !!p.admin, queued: !!p.queued, role: p.role, hp: p.hp, status: p.status || 'hub' };
}

/* ----------------------------------------------------------------------------
 * Match broadcast (20 Hz)
 * -------------------------------------------------------------------------*/
function broadcastMatch(match) {
  const obj = {
    t: 'state', type: 'match', id: match.id, state: match.state,
    map: matchView(match),
    players: [],
  };
  for (const p of match.players) {
    if (!players.has(p.id)) continue;
    obj.players.push({
      id: p.id, name: p.name, role: p.role, x: p.x, y: p.y, z: p.z, yaw: p.yaw,
      hp: p.hp, status: p.status, carrier: p.carrier ? { id: p.carrier } : null,
      sprint: p.role === 'killer' ? p.sprint : undefined,
      progress: p.reviveT ? p.reviveT : undefined,
    });
  }
  for (const p of match.players) if (players.has(p.id)) send(p, obj);
}

/* ----------------------------------------------------------------------------
 * Bans / anti-cheat
 * -------------------------------------------------------------------------*/
function autoBan(p, kind) {
  let dur = 3600 * 1000;
  bans.users[p.nameLow] = { reason: `AUTO-BAN: ${kind}`, until: Date.now() + dur, at: Date.now(), by: 'anticheat' };
  save('bans.json', bans, true);
  logCheat({ name: p.name, ip: p.ip, kind: 'auto-ban', reason: kind });
  broadcastToast(`${p.name} was banned (${kind}).`);
  kickLater(p, 'Banned for suspicious behavior');
}

function kickLater(p, msg) {
  try { p.ws.send(JSON.stringify({ t: 'ejected', msg })); } catch {}
  setTimeout(() => { try { p.ws.close(); } catch {} }, 300);
}

function manualBan({ name, ip, reason, durMin, by }) {
  const until = durMin > 0 ? Date.now() + durMin * 60000 : 0;
  if (name) bans.users[name.toLowerCase()] = { reason, until, at: Date.now(), by };
  if (ip) bans.ips[ip] = { reason, until, at: Date.now(), by };
  save('bans.json', bans, true);
  for (const p of players.values()) {
    if ((name && p.nameLow === name.toLowerCase()) || (ip && p.ip === ip)) {
      kickLater(p, `You were banned from the fog (${reason}).`);
    }
  }
  broadcastToast(`${name || ip} was banned.`);
  log('BAN', 'admin', `${by} banned ${name || ip}: ${reason} for ${durMin || 0}min`);
}

/* ----------------------------------------------------------------------------
 * Admin commands (ban tool)
 * -------------------------------------------------------------------------*/
function onAdmin(p, msg) {
  if (!p.admin) return;
  switch (msg.op) {
    case 'list': return sendAdminSnapshot(p);
    case 'banUser': return manualBan({ name: msg.name, reason: msg.reason || 'violating rules', durMin: msg.durMin || 0, by: p.name });
    case 'unbanUser':
      delete bans.users[String(msg.name).toLowerCase()];
      save('bans.json', bans, true);
      sendAdminSnapshot(p);
      return;
    case 'banIp': return manualBan({ ip: msg.ip, reason: msg.reason || 'violating rules', durMin: msg.durMin || 0, by: p.name });
    case 'unbanIp':
      delete bans.ips[String(msg.ip)];
      save('bans.json', bans, true);
      sendAdminSnapshot(p);
      return;
    case 'kick':
      const t = Array.from(players.values()).find(p2 => p2.name && (p2.name === msg.name || p2.id === String(msg.name)));
      if (t) kickLater(t, 'Kicked by an admin.');
      return;
    case 'log': return sendAdminLog(p);
    default: return;
  }
}

function sendAdminSnapshot(p) {
  send(p, {
    t: 'adminSnapshot',
    online: Array.from(players.values())
      .filter(p2 => p2.name)
      .map(p2 => ({ id: p2.id, name: p2.name, ip: p2.ip, admin: p2.admin, state: p2.state, queued: p2.queued, role: p2.role })),
    bans,
  });
}
function sendAdminLog(p) { send(p, { t: 'adminLog', log: cheatLog.slice(0, 200) }); }

function broadcastAdmin(msg) { for (const p of players.values()) if (p.admin && p.name) send(p, msg); }

/* ----------------------------------------------------------------------------
 * Disconnect / cleanup
 * -------------------------------------------------------------------------*/
function onClose(p) {
  clientFor.delete(p.ws);
  players.delete(p.id);
  const i = queue.indexOf(p);
  if (i >= 0) queue.splice(i, 1);
  if (p.name) broadcastToast(`${p.name} left the fog.`);
  if (p.state === 'match') {
    const m = getMatch(p);
    if (m) broadcastMatch(m);
  }
  p.state = 'hub';
  p.matchId = null;
  p.queued = false;
}

/* ----------------------------------------------------------------------------
 * Top leaderboard
 * -------------------------------------------------------------------------*/
function topStats(n) {
  return Object.entries(stats)
    .map(([name, s]) => ({ name, ...s, pts: (s.esc || 0) * 3 + (s.wins || 0) * 2 + (s.kills || 0) * 3 - (s.dead || 0) }))
    .sort((a, b) => b.pts - a.pts)
    .slice(0, n);
}

/* ----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------*/
function send(p, msg) {
  try { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); } catch {}
}
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) {
    try { if (p.ws.readyState === 1) p.ws.send(data); } catch {}
  }
}
function broadcastToast(msg) { broadcast({ t: 'toast', msg }); }
function log(tag, id, detail) { const line = `[${new Date().toISOString()}] ${tag} ${id} — ${detail}`; try { fs.appendFile(path.join(DATA, 'server.log'), line + '\n', () => {}); } catch {} console.log(line); }

function returnToHub(p) {
  p.state = 'hub';
  p.matchId = null;
  p.role = null;
  p.keys.clear();
  p.inputBuffer.length = 0;
  p.x = rint(-20, 20); p.z = rint(-20, 20); p.y = 0;
  send(p, { t: 'returnHub', cfg: { hubW: config.hubW }, stats: topStats(5) });
}

/* ----------------------------------------------------------------------------
 * Boot
 * -------------------------------------------------------------------------*/
// Last line of defense: one bad message must never take down the whole night.
process.on('uncaughtException', (err) => {
  try { console.error('[UNCAUGHT]', err); log('UNCAUGHT', 'server', err.message); } catch {}
});
process.on('unhandledRejection', (err) => {
  try { console.error('[UNHANDLED]', err); log('UNHANDLED', 'server', (err && err.message) || err); } catch {}
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================');
  console.log('  DEAD BY NIGHTLIGHT  —  MMO dark survival');
  console.log('--------------------------------------------------');
  console.log(`  Live at   : http://localhost:${PORT}`);
  console.log(`  LAN       : http://<your-ip>:${PORT}`);
  console.log(`  Admin tool: http://localhost:${PORT}/admin.html`);
  console.log(`  Admin key : ${ADMIN_TOKEN}`);
  console.log('--------------------------------------------------');
  console.log('  Anti-cheat : server-authoritative movement,');
  console.log('               input-flood gate, auto-ban, ban tool.');
  console.log('==================================================');
});