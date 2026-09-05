/* DEAD BY NIGHTLIGHT — 3D browser client (Three.js) */
'use strict';

/* ---------------- bare DOM helpers ---------------- */
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const FWD = (yaw) => ({ x: Math.sin(yaw), z: -Math.cos(yaw) });
const RIGHT = (yaw) => ({ x: Math.cos(yaw), z: Math.sin(yaw) });
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

/* ---------------- networking ---------------- */
let ws = null;
let selfId = null, selfName = null, isAdmin = false;
let role = null;             // 'killer' | 'survivor' | hub
let my = { id: null, x: 0, y: 0, z: 0, yaw: 0, hp: 2, status: 'alive', sprint: 100 };

// survivor outfits (mirrors server OUTfits)
const OUTfits = [
  { name: 'Ranger',   body: 0x2f7f8f, skin: 0xd9b48f, accent: 0x26303f, hair: 0x5a3b26 },
  { name: 'Ghost',    body: 0x9aa2b8, skin: 0xe6d7c0, accent: 0x6d7790, hair: 0xf2e9d8 },
  { name: 'Crimson',  body: 0x8f2f3a, skin: 0xd9b48f, accent: 0x3a1f24, hair: 0x2a1a16 },
  { name: 'Jade',     body: 0x2f7f4f, skin: 0xd9b48f, accent: 0x1f3a2c, hair: 0x3a2a1a },
  { name: 'Amber',    body: 0x7f6a2f, skin: 0xcfae8b, accent: 0x3a3420, hair: 0x1c1c1c },
  { name: 'Violet',   body: 0x5a3f8f, skin: 0xd0c0d8, accent: 0x2c1f3a, hair: 0x4a3a6d },
  { name: 'Ash',      body: 0x5f5f6d, skin: 0xbfae9a, accent: 0x303038, hair: 0x8a8a98 },
  { name: 'Warden',   body: 0x3f4a5a, skin: 0xd9b48f, accent: 0x262e3a, hair: 0x6d5438 },
];

// killer archetypes (mirrors server KILLERS) — used for looks; stats come from server
const KILLERS = {
  ravager: { name: 'The Ravager', body: 0x7a1f18, skin: 0x3a2a20, accent: 0xff2a0a, scale: 1.3, weapon: 'cleaver' },
  brute:   { name: 'The Brute',   body: 0x3a3a22, skin: 0x2a241a, accent: 0xffb01a, scale: 1.55, weapon: 'maul' },
  whisper: { name: 'The Whisper', body: 0x1f2f4f, skin: 0xbfe3ff, accent: 0x6fc9ff, scale: 1.15, weapon: 'sickle' },
  umbra:   { name: 'The Umbra',   body: 0x241a30, skin: 0x2a2536, accent: 0xbf5dff, scale: 1.35, weapon: 'blade' },
};
let matchMap = null;         // { gens, gates, hooks }
let matchState = 'hub';      // 'hub' | 'running' | 'done'
let matchKillerId = null;
let hubPlayers = [];
let matchPlayers = [];
let queueSize = 0, matchesActive = 0;
let lastPing = { rtt: null };
let camFollowId = null;
let pickItem = null;
let myItem = null;
let pickedOutfit = 0;

/* Set this to your Ko-fi / BuyMeACoffee page so players can support you.
   Leave empty ('') to hide the Tip Us button entirely. */
const TIP_URL = 'https://ko-fi.com/sugadev';

/* ---------------- saved login ("remember me") ----------------
 * The last successful login is stored in localStorage so you don't have to
 * re-type it and the game can reconnect automatically after the server kicks
 * you or a reload. "Logout" clears this saved session.
 * NOTE: the password is stored locally in your browser (like a browser's own
 * "save password"), so only enable this on a device/account you trust. */
const SESSION_KEY = 'dbn_session_v1';
function saveSession() {
  const s = {
    name: $('name').value.trim(),
    email: $('email').value.trim(),
    pass: $('pass').value,
    admin: $('adminkey').value.trim(),
    outfit: pickedOutfit,
  };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
}
function loadSession() {
  try { const raw = localStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}
let autoReconnect = false; // becomes true after a successful login this page-load
let reconnectTries = 0;

function connect(name, pass, mode) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const useMode = mode || authMode;
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({
    t: useMode === 'register' ? 'register' : 'login',
    name: name || $('name').value.trim(),
    pass: pass || '',
    email: useMode === 'register' ? $('email').value.trim() : '',
    outfit: pickedOutfit,
    admin: $('adminkey').value.trim(),
  }));
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch { } };
  ws.onclose = () => {
    if (autoReconnect && reconnectTries < 5) {
      reconnectTries++;
      setTimeout(() => {
        if (autoReconnect) {
          toast('Reconnecting…', 'bad');
          connect(null, null, 'login');
        }
      }, 1200 * reconnectTries);
      return;
    }
    autoReconnect = false; reconnectTries = 0;
    toast('Connection lost. Log in again.', 'bad');
    $('login').style.display = 'flex';
  };
}

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function handle(msg) {
  switch (msg.t) {
    case 'auth':
      if (msg.ok) {
        selfId = msg.id; selfName = msg.name; isAdmin = !!msg.admin;
        if (!$('name').value) $('name').value = msg.name;      // refill on autologin
        if (authMode !== 'login') { authMode = 'login'; $('email').style.display = 'none'; }
        saveSession();                                       // remember these credentials
        autoReconnect = true; reconnectTries = 0;
        $('login').style.display = 'none';
        $('hint').style.display = 'block';
        if (document.activeElement) document.activeElement.blur();
        start();
      } else {
        autoReconnect = false;
        $('authmsg').textContent = msg.msg;
      }
      break;
    case 'state':
      if (msg.type === 'hub') {
        hubPlayers = msg.players;
        if (msg.you) my = { ...my, ...msg.you };
        for (const p of msg.players) {
          const e = ensurePlayer(p);
          targetPos.set(p.id, { x: p.x, y: p.y, z: p.z, yaw: p.yaw, status: 'alive', hp: 2, hub: true });
        }
        const seen = new Set(msg.players.map(p => p.id));
        playerMeshes.forEach((entry, id) => {
          if (!seen.has(id)) { scene.remove(entry.group); playerMeshes.delete(id); targetPos.delete(id); }
        });
      }
      else if (msg.type === 'match') { matchState = msg.state; matchMap = msg.map; matchPlayers = msg.players; ifMenu(); }
      break;
    case 'matchStart':
      role = msg.match.role; matchMap = msg.match.map; matchState = 'running'; matchKillerId = msg.match.killerId || 'ravager';
      enterMatch(); showSplash(matchMap, role);
      if (msg.match.role === 'killer') sfx('sting');
      toast(role === 'killer' ? 'You are THE KILLER. Hunt them all.' : 'You are a SURVIVOR. Repair 5 generators & escape!', role === 'killer' ? 'bad' : 'good');
      break;
    case 'returnHub':
      role = null; matchState = 'hub'; matchMap = null; matchPlayers = []; matchKillerId = null;
      if (hubCount) { clearInterval(hubCount); hubCount = null; }
      hideSplash(); leaveMatch(); toast('Back at the survivor hub.');
      break;
    case 'matchEnd':
      endMatch(msg.result, msg.mine);
      break;
    case 'toast':
      if (/gates are powered/i.test(msg.msg)) sfx('power');
      if (/ECLIPSE BLINKS/i.test(msg.msg)) sfx('eclipse');
      if (/You wounded/i.test(msg.msg)) sfx('hit');
      toast(msg.msg); break;
    case 'chat': chat(msg.from, msg.msg, msg.admin); break;
    case 'queue': queueSize = msg.size; updateHud(); break;
    case 'queueInfo': queueSize = msg.size; matchesActive = msg.matches; updateHud(); break;
    case 'reset':
      $('rmsg').textContent = msg.msg || '';
      if (msg.devCode) $('rcode').value = msg.devCode;
      break;
    case 'ejected': sfx('sting'); toast(msg.msg, 'bad'); break;
    case 'pong': if (msg.ts) lastPing.rtt = performance.now() - Number(msg.ts); break;
    case 'sfx': sfx(msg.kind === 'pickup' ? 'power' : 'sting'); break;
  }
}

/* ---------------- three.js scene ---------------- */
let scene, camera, renderer;
let hubGroup = null, matchGroup = null;
let playerMeshes = new Map();   // id -> {group, nameSprite, mats...}
let genMeshes = new Map(), hookMeshes = new Map(), gateMeshes = new Map();
let itemMeshes = new Map(), hatchMesh = null;
let wallMeshes = [], powerMesh = null;
let targetPos = new Map();      // id -> {x,z,y,yaw,status,carrier,hp}
let prevPos = new Map();        // id -> {x,z,y} snapshot BEFORE the latest target (for interpolation)
let lastServerT = 0;            // performance.now() of the most recent state frame

const isDowned = (s) => s === 'downed';
const isDead = (s) => s === 'dead' || s === 'escaped';

const BASE_SKY = 0x060a14, BASE_FOG = 0x0a0f1e;
const THEMES = {
  hollow: { floor: 0x141a26, grid: 0x1c2434, tree: [0x16212e, 0x1c3324, 0x2a3440] },
  farm:   { floor: 0x151b10, grid: 0x202a18, tree: [0x1c2a16, 0x223820, 0x3a3320] },
  graveyard: { floor: 0x161722, grid: 0x22222f, tree: [0x1d1f2c, 0x2a2b3a, 0x34323f] },
  asylum: { floor: 0x1a1620, grid: 0x282030, tree: [0x1f1830, 0x2a2040, 0x352e2e] },
};

function start() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(BASE_SKY);
  scene.fog = new THREE.Fog(BASE_FOG, 40, 120);

  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 400);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  $('scene').appendChild(renderer.domElement);

  const hemi = new THREE.HemisphereLight(0x8899cc, 0x1a0f10, 0.85);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0xb8c8ff, 0.6);
  moon.position.set(30, 60, 10);
  scene.add(moon);
  scene.add(new THREE.AmbientLight(0x223044, 0.6));

  buildHub();
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
  animate();
}

function buildHub() {
  hubGroup = new THREE.Group(); scene.add(hubGroup);
  const g = new THREE.Mesh(new THREE.PlaneGeometry(64, 64), new THREE.MeshLambertMaterial({ color: 0x1a2233 }));
  g.rotation.x = -Math.PI / 2; g.receiveShadow = true; hubGroup.add(g);
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(64, 64), new THREE.MeshBasicMaterial({ color: 0x1d2638, transparent: true, opacity: 0.35 }));
  grid.rotation.x = -Math.PI / 2; grid.position.y = 0.02; hubGroup.add(grid);
  // beacon pylon
  const pylon = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 9, 12), new THREE.MeshLambertMaterial({ color: 0x9a5dff }));
  pylon.position.y = 4.5; hubGroup.add(pylon);
  const glow = new THREE.Mesh(new THREE.SphereGeometry(1.3, 16, 16), new THREE.MeshBasicMaterial({ color: 0xb78cff }));
  glow.position.y = 9; hubGroup.add(glow);
  trees(hubGroup, 40, 30);
}

function enterMatch() {
  leaveMatch();
  matchGroup = new THREE.Group(); scene.add(matchGroup);
  const theme = THEMES[matchMap.theme] || THEMES.hollow;
  scene.background = new THREE.Color(matchMap.theme === 'farm' ? 0x08110a : matchMap.theme === 'graveyard' ? 0x0a0912 : BASE_SKY);
  scene.fog = new THREE.Fog(matchMap.theme === 'farm' ? 0x0c1a0e : matchMap.theme === 'graveyard' ? 0x100e1c : BASE_FOG, 40, 120);
  const w = 90, h = w;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshLambertMaterial({ color: theme.floor }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; matchGroup.add(floor);
  const grd = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: theme.grid, transparent: true, opacity: 0.4 }));
  grd.rotation.x = -Math.PI / 2; grd.position.y = 0.02; matchGroup.add(grd);

  // perimeter walls with gaps at the map's gates
  const wallMat = new THREE.MeshLambertMaterial({ color: matchMap.theme === 'farm' ? 0x3a3d26 : matchMap.theme === 'graveyard' ? 0x33303f : 0x2a3140 });
  const mkWall = (x, z, ww, dd) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(ww, 4, dd), wallMat);
    m.position.set(x, 2, z); m.castShadow = true; matchGroup.add(m);
  };
  const gz = 4; // half-width of a gate gap
  const T = 1.2;
  const gaps = new Set((matchMap.gates || []).map(g => g.dir));
  const sideX = (fixed, has) => {
    if (has) mkWall(fixed, 0, T, 90);
    else { mkWall(fixed, -44 + (44 - gz) / 2, T, 44 - gz); mkWall(fixed, gz + (44 - gz) / 2, T, 44 - gz); }
  };
  const sideZ = (fixed, has) => {
    if (has) mkWall(0, fixed, 90, T);
    else { mkWall(-44 + (44 - gz) / 2, fixed, 44 - gz, T); mkWall(gz + (44 - gz) / 2, fixed, 44 - gz, T); }
  };
  sideZ(45, gaps.has('north'));
  sideZ(-45, gaps.has('south'));
  sideX(-45, gaps.has('west'));
  sideX(45, gaps.has('east'));

  trees(matchGroup, 50, 44, theme.tree);

  // generators
  for (const g of matchMap.gens) {
    const grp = genGroup();
    grp.position.set(g.x, 0, g.z);
    matchGroup.add(grp);
    genMeshes.set(g.id, { grp, core: grp.children[3], bar: grp.children[5] });
  }
  // hooks
  for (const hk of matchMap.hooks) {
    const grp = hookGroup();
    grp.position.set(hk.x, 0, hk.z);
    matchGroup.add(grp);
    hookMeshes.set(hk.x + '_' + hk.z, grp);
  }
  // gates
  for (const g of matchMap.gates) {
    const grp = gateGroup(g.dir);
    grp.position.set(g.x, 0, g.z);
    matchGroup.add(grp);
    gateMeshes.set(g.id, grp);
  }
  // jumpable vault walls (killers can't pass, survivors vault over)
  wallMeshes = [];
  for (const w of (matchMap.walls || [])) {
    const grp = wallGroup(w);
    grp.position.set(w.x, 0, w.z);
    matchGroup.add(grp);
    wallMeshes.push(grp);
  }
  // power switch (flip to power the exit gates)
  if (matchMap.power) {
    const grp = powerGroup();
    grp.position.set(matchMap.power.x, 0, matchMap.power.z);
    matchGroup.add(grp);
    powerMesh = grp;
  }
  // item pickups
  for (const it of (matchMap.items || [])) {
    const grp = itemGroup(it.type);
    grp.position.set(it.x, 0, it.z);
    matchGroup.add(grp);
    itemMeshes.set(it.id, grp);
  }
  // hatch (for the Hatch Key)
  if ((matchMap.keys || []).length) {
    const k = matchMap.keys[0];
    const grp = hatchGroup();
    grp.position.set(k.x, 0, k.z);
    matchGroup.add(grp);
    hatchMesh = grp;
  }
  $('mm').style.display = 'block';
}

function trees(group, n, spread, palette) {
  const pal = palette || [0x16212e, 0x1c3324, 0x2a3440];
  const matT = new THREE.MeshLambertMaterial({ color: 0x3a2a1a });
  const matL = new THREE.MeshLambertMaterial({ color: pal[1] });
  const matR = new THREE.MeshLambertMaterial({ color: pal[2] });
  for (let i = 0; i < n; i++) {
    const x = (Math.random() * 2 - 1) * spread, z = (Math.random() * 2 - 1) * spread;
    if (Math.abs(x) < 4 && Math.abs(z) < 4) continue; // keep center clear
    const t = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 1.4, 6), matT);
    trunk.position.y = 0.7;
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.6 + Math.random() * 0.5, 1.6, 7), Math.random() < 0.5 ? matL : matR);
    leaf.position.y = 1.9;
    leaf.rotation.y = Math.random() * Math.PI;
    t.add(trunk); t.add(leaf);
    t.position.set(x, 0, z);
    group.add(t);
  }
}

function genGroup() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 0.6, 8), new THREE.MeshLambertMaterial({ color: 0x3a4a63 })));
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.9, 8), new THREE.MeshLambertMaterial({ color: 0x4a6080 })).translateY(0.75));
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 1.2), new THREE.MeshLambertMaterial({ color: 0x2c3a52 })).translateY(1.2));
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.32, 10, 10), new THREE.MeshBasicMaterial({ color: 0xffd24e }));
  core.position.y = 1.45;
  g.add(core);
  g.add(new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.06, 6, 14), new THREE.MeshBasicMaterial({ color: 0x8fa9e0 })).translateY(1.45));
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.4, 0.16), new THREE.MeshBasicMaterial({ color: 0xffd24e, transparent: true, opacity: 0.85 }));
  bar.position.y = 0.7;
  g.add(bar);
  return g;
}
function hookGroup() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.4, 6), new THREE.MeshLambertMaterial({ color: 0x5a1f1a })).translateY(1.7));
  g.add(new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.08, 6, 12), new THREE.MeshBasicMaterial({ color: 0x9a5040 })).translateY(3.2));
  return g;
}
function gateGroup(dir) {
  const g = new THREE.Group();
  const post = new THREE.MeshLambertMaterial({ color: 0x2a3547 });
  const glow = new THREE.MeshBasicMaterial({ color: 0x3dff7a, transparent: true, opacity: 0.25 });
  if (dir === 'north') {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 4, 0.8), post).translateX(-4));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 4, 0.8), post).translateX(4));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(8, 0.6, 0.9), new THREE.MeshLambertMaterial({ color: 0x3a4a63 })).translateY(3.2));
    const g1 = new THREE.Mesh(new THREE.PlaneGeometry(9, 1.2), glow); g1.rotation.x = -Math.PI / 2; g1.position.set(0, 0.05, 0); g.add(g1);
  } else {
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 4, 0.8), post).translateZ(-4));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 4, 0.8), post).translateZ(4));
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 8), new THREE.MeshLambertMaterial({ color: 0x3a4a63 })).translateY(3.2));
    const g1 = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 9), glow); g1.rotation.x = -Math.PI / 2; g1.position.set(0, 0.05, 0); g.add(g1);
  }
  return g;
}
function wallGroup(w) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w.w, w.h, w.d), new THREE.MeshLambertMaterial({ color: 0x4a3a33 }));
  body.position.y = w.h / 2;
  const top = new THREE.Mesh(new THREE.BoxGeometry(w.w + 0.06, 0.14, w.d + 0.06), new THREE.MeshLambertMaterial({ color: 0x6d5748 }));
  top.position.y = w.h + 0.05;
  g.add(body, top);
  return g;
}
function powerGroup() {
  const g = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.5, 0.7), new THREE.MeshLambertMaterial({ color: 0x2a2436 }));
  box.position.y = 0.75;
  const face = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.55, 0.1), new THREE.MeshBasicMaterial({ color: 0xffd24e }));
  face.position.set(0, 0.85, 0.36);
  const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 8), new THREE.MeshLambertMaterial({ color: 0xc9ccd6 }));
  lever.position.set(0, 1.0, 0.5); lever.rotation.x = -0.3;
  g.add(box, face, lever);
  g.userData.face = face;
  return g;
}

function leaveMatch() {
  if (matchGroup) { scene.remove(matchGroup); matchGroup = null; }
  playerMeshes.forEach((o) => scene.remove(o.group));
  playerMeshes.clear(); targetPos.clear(); prevPos.clear();
  itemMeshes.clear(); genMeshes.clear(); hookMeshes.clear(); gateMeshes.clear(); hatchMesh = null;
  wallMeshes = []; powerMesh = null;
  $('mm').style.display = 'none';
  $('end').style.display = 'none';
  $('prompt').style.display = 'none';
}

// item colors for rendering
const ITEM_COLORS = { medkit: 0x3dff7a, toolbox: 0xffd24e, flash: 0xd9f2ff, key: 0xbf5dff };
function itemGroup(type) {
  const g = new THREE.Group();
  const col = ITEM_COLORS[type] || 0xffffff;
  // floating glowing core
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 10), new THREE.MeshBasicMaterial({ color: col }));
  core.position.y = 0.55;
  // soft halo ring
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.4, 0.05, 6, 14), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.55;
  g.add(core); g.add(ring);
  // small base pad
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 0.1, 8), new THREE.MeshLambertMaterial({ color: 0x22222a })).translateY(0.05));
  g.userData.baseY = 0.55;
  return g;
}
function hatchGroup() {
  const g = new THREE.Group();
  const cover = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 1.6), new THREE.MeshLambertMaterial({ color: 0x3a3f4e }));
  cover.position.y = 0.1;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.06, 6, 20), new THREE.MeshBasicMaterial({ color: 0xbf5dff }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.22;
  g.add(cover, ring);
  return g;
}

/* ---------------- player meshes ---------------- */
function makeNameSprite(name) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.font = 'bold 36px Segoe UI'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillText(name, 130, 34);
  ctx.fillStyle = '#eaf3ff'; ctx.fillText(name, 128, 32);
  const tex = new THREE.CanvasTexture(cv);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(3.2, 0.8, 1);
  return sp;
}

function ensurePlayer(p) {
  let entry = playerMeshes.get(p.id);
  if (entry) return entry;
  const isKiller = p.role === 'killer';
  const killer = isKiller ? (KILLERS[matchKillerId] || KILLERS.ravager) : null;
  const outfit = OUTfits[p.outfit] || OUTfits[0];
  const bodyCol = isKiller ? killer.body : outfit.body;
  const skinCol = isKiller ? killer.skin : outfit.skin;
  const group = new THREE.Group();

  const limb = (mat) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.55, 8), mat);
    m.position.y = -0.28; // pivot at shoulder/hip
    return m;
  };
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.78, 0.38), new THREE.MeshLambertMaterial({ color: bodyCol }));
  body.position.y = 1.05;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), new THREE.MeshLambertMaterial({ color: skinCol }));
  head.position.y = 1.68;

  const armMat = new THREE.MeshLambertMaterial({ color: isKiller ? killer.skin : outfit.accent });
  const legMat = new THREE.MeshLambertMaterial({ color: isKiller ? 0x16161c : outfit.accent });
  const armL = limb(armMat), armR = limb(armMat);
  armL.position.x = -0.42; armR.position.x = 0.42;
  armL.position.y = 1.62; armR.position.y = 1.62;
  // legs — wider apart and slightly thicker so both legs are clearly visible
  const legGeo = new THREE.CylinderGeometry(0.14, 0.11, 0.62, 8);
  const legL = new THREE.Mesh(legGeo, legMat), legR = new THREE.Mesh(legGeo, legMat);
  legL.position.x = -0.24; legR.position.x = 0.24;
  legL.position.y = 0.66; legR.position.y = 0.66;
  legL.castShadow = true; legR.castShadow = true;

  group.add(body, head, armL, armR, legL, legR);

  const name = makeNameSprite(p.name);
  group.add(name);

  let baseScale = 1;
  if (isKiller) {
    baseScale = killer.scale;
    // glowing eyes
    const e1 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.05), new THREE.MeshBasicMaterial({ color: killer.accent }));
    const e2 = e1.clone();
    e1.position.set(-0.11, 1.72, 0.23); e2.position.set(0.11, 1.72, 0.23);
    group.add(e1); group.add(e2);
    // killer mask/head shape
    head.material = new THREE.MeshLambertMaterial({ color: killer.skin });
    head.scale.setScalar(1.15);
    // weapon — held in right hand, angled forward
    const weapon = new THREE.Group();
    const wMat = new THREE.MeshLambertMaterial({ color: 0x2a2a34 });
    if (killer.weapon === 'maul') {
      const h1 = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.5, 8), new THREE.MeshLambertMaterial({ color: 0x4a3a2a }));
      h1.rotation.z = Math.PI / 2; h1.position.set(0.5, 0, 0);
      const h2 = h1.clone(); h2.rotation.z = Math.PI / 2; h2.position.set(0.5, 0, 0);
      weapon.add(h1);
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6), wMat);
      st.rotation.z = Math.PI / 2; weapon.add(st);
    } else if (killer.weapon === 'sickle') {
      const bl = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.07, 6, 10), new THREE.MeshLambertMaterial({ color: 0xa8b2c4 }));
      bl.position.set(0.9, 0.25, 0);
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.4, 6), wMat);
      st.rotation.z = Math.PI / 2; weapon.add(bl, st);
    } else if (killer.weapon === 'blade') {
      const bl = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 0.06), new THREE.MeshLambertMaterial({ color: 0xbfa8e0 }));
      bl.position.set(0.8, 0.1, 0);
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.2, 6), wMat);
      st.rotation.z = Math.PI / 2; weapon.add(bl, st);
    } else { // cleaver
      const bl = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.07), new THREE.MeshLambertMaterial({ color: 0xc9ccd6 }));
      bl.position.set(0.55, 0.15, 0);
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 6), wMat);
      st.rotation.z = Math.PI / 2; weapon.add(bl, st);
    }
    weapon.position.set(0.0, -0.15, 0.35);
    weapon.rotation.z = -0.35;
    armR.add(weapon);
    name.position.y = 3.4;
  } else {
    // survivor hair / hood piece — a small cap on top of the head
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: outfit.hair }));
    hair.position.y = 1.78;
    group.add(hair);
    name.position.y = 2.35;
  }
  group.scale.set(baseScale, baseScale, baseScale);

  entry = { group, name, isKiller, armL, armR, legL, legR, moving: null };
  playerMeshes.set(p.id, entry);
  if (matchState !== 'hub' && matchGroup) matchGroup.add(group);
  else scene.add(group);
  return entry;
}

function setPose(entry, moving, dead, downed) {
  if (!entry) return;
  if (moving) entry.moving = moving;
  if (dead || downed) {
    entry.armL.rotation.z = Math.PI / 2; entry.armR.rotation.z = -Math.PI / 2;
    entry.legL.rotation.x = 0; entry.legR.rotation.x = 0;
    entry.group.rotation.z = Math.PI / 2;
    return;
  }
  entry.group.rotation.z = 0;
  if (entry.moving) {
    const s = Math.sin(performance.now() / 90);
  // Keep arms low when walking/running so they hang near the hips instead of
  // flailing up at the shoulders; legs keep a natural, bigger stride.
  const armSwing = s * (entry.isKiller ? 0.16 : 0.12);
  const legSwing = s * 0.55;
  entry.armL.rotation.x = armSwing; entry.armR.rotation.x = -armSwing;
  entry.legL.rotation.x = -legSwing; entry.legR.rotation.x = legSwing;
  } else {
    entry.armL.rotation.x = 0; entry.armR.rotation.x = 0;
    entry.legL.rotation.x = 0; entry.legR.rotation.x = 0;
  }
}

/* ---------------- render loop ---------------- */
let camSmooth = { x: 0, z: 0, y: 0, yaw: my.yaw, pitch: -0.35 };
let animT = 0;

function animate() {
  requestAnimationFrame(animate);
  let delta = (performance.now() - animT) / 16;
  animT = performance.now();
  delta = clamp(delta, 0.2, 3);

  if (matchState !== 'hub') my = { ...my, x: my.x, z: my.z, y: my.y, yaw: my.yaw };

  // lerp all meshes toward server targets
  playerMeshes.forEach((entry, id) => {
    const t = targetPos.get(id);
    if (!t) return;
    const g = entry.group;
    const cur = t;
    const prev = prevPos.get(id) || { x: cur.x, y: cur.y, z: cur.z };
    // interpolate between the previous and latest server position via render time,
    // so fast movers (killer) glide smoothly between 20Hz frames instead of stepping.
    const alpha = matchState !== 'hub' ? clamp((performance.now() - lastServerT) / 45, 0, 1) : 1;
    const ix = prev.x + (cur.x - prev.x) * alpha;
    const iz = prev.z + (cur.z - prev.z) * alpha;
    const iy = prev.y + (cur.y - prev.y) * alpha;
    g.position.x += (ix - g.position.x) * Math.min(1, 0.5 * delta);
    g.position.z += (iz - g.position.z) * Math.min(1, 0.5 * delta);
    g.position.y += (iy - g.position.y) * Math.min(1, 0.4 * delta);
    targetYaw(g, t.yaw);
    // status styling
    const isYou = id === selfId;
    const dead = isDead(t.status);
    g.visible = t.status !== 'hub' && (matchState === 'hub' || !dead || isYou);
    const downed = isDowned(t.status) || t.carrier;
    if (downed) { g.position.y = Math.min(g.position.y, 0); }
    else g.position.y = Math.max(g.position.y, 0);
    // animated limbs (only upright, living figures)
    if (!downed && !dead) {
      const moving = Math.hypot(iz - prev.z, ix - prev.x) > 0.001;
      setPose(entry, moving, false, false);
    } else {
      setPose(entry, false, dead || (downed && isYou && t.status === 'dead'), downed);
    }
  });

  // camera follow: self, or ghost-spectate a survivor's match when dead/escaped
  const meSelf = targetPos.get(selfId) || my;
  let me = meSelf;
  if (matchState !== 'hub' && matchPlayers.length) {
    const M = matchPlayers.find(p => p.id === selfId);
    if (M && M.role === 'survivor' && (M.status === 'dead' || M.status === 'escaped')) {
      const k = matchPlayers.find(p => p.role === 'killer');
      const t = (k && targetPos.get(k.id)) ? k.id : null;
      const watched = t != null ? t : (matchPlayers.find(p => p.role === 'survivor' && p.id !== selfId && p.status !== 'dead') || {}).id;
      camFollowId = watched != null ? watched : selfId;
      me = targetPos.get(camFollowId) || meSelf;
    } else camFollowId = null;
  } else camFollowId = null;
  const yaw = me.yaw || my.yaw || 0;
  camSmooth.yaw += (yaw - camSmooth.yaw) * 0.12 * delta;
  camSmooth.pitch = clamp(Math.max(-0.9, camSmooth.pitch), -1, -0.2);
  const dist = role === 'killer' ? 7 : 6;
  const back = FWD(camSmooth.yaw);
  const cpx = me.x - back.x * dist, cpz = me.z - back.z * dist;
  camera.position.lerp(new THREE.Vector3(cpx, clamp(me.y || 0, 0, 3) + 4.2, cpz), 0.28 * delta);
  camera.lookAt(me.x, clamp(me.y || 0, 0, 3) + 1.2, me.z);

  // gens live update
  if (matchMap) {
    for (const g of matchMap.gens) {
      const m = genMeshes.get(g.id);
      if (!m) continue;
      m.core.material.color.setHex(g.done ? 0x3dff7a : 0xffd24e);
      m.core.scale.setScalar(0.4 + g.prog * 0.9);
      m.core.position.y = 1.3 + g.prog * 0.25;
      m.bar.scale.y = Math.max(0.1, g.prog);
      m.bar.position.y = 0.15 + 0.7 * m.bar.scale.y;
      m.bar.material.color.setHex(g.done ? 0x3dff7a : 0xffd24e);
    }
    for (const g of matchMap.gates) {
      const gm = gateMeshes.get(g.id);
      if (gm) gm.rotation.y = g.open ? 0 : 0;
    }
    // item pickups: bobbing + hide if taken
    if (matchMap.items) {
      const t = performance.now() / 420;
      for (const it of matchMap.items) {
        const gm = itemMeshes.get(it.id);
        if (!gm) continue;
        gm.visible = !it.taken;
        if (!it.taken) { gm.position.y = (it.id.charCodeAt(1) % 5) * 0.001; const by = 0.55 + Math.sin(t + it.x) * 0.12; gm.children[0].position.y = by; gm.children[1].position.y = by; }
      }
    }
    // power switch: faces glow green once powered
    if (powerMesh && matchMap.power) {
      powerMesh.userData.face.material.color.setHex(matchMap.power.on ? 0x3dff7a : 0xffd24e);
      powerMesh.visible = true;
    }
  }

  renderer.render(scene, camera);
  updateHud();
  updatePrompt();
  drawMinimap();
}

function targetYaw(g, y) {
  let dy = (y - g.rotation.y) % (Math.PI * 2);
  if (dy > Math.PI) dy -= Math.PI * 2; if (dy < -Math.PI) dy += Math.PI * 2;
  g.rotation.y += dy * 0.3;
}

/* ---------------- input & pointer lock ---------------- */
let keys = new Set();
let look = { yaw: 0, pitch: -0.35 };
let pointerLocked = false;

document.addEventListener('mousemove', (e) => {
  if (!pointerLocked) return;
  look.yaw -= e.movementX * 0.0026;
  look.pitch = clamp(look.pitch - e.movementY * 0.0026, -1.1, 0.5);
});

document.addEventListener('mousedown', (e) => {
  if (e.button === 0) keys.add('m1');
  if (!pointerLocked && matchState !== 'hub') document.body.requestPointerLock && document.body.requestPointerLock();
});
document.addEventListener('mouseup', (e) => { if (e.button === 0) keys.delete('m1'); });

function isTyping() {
  const a = document.activeElement;
  if (selfId && matchState !== 'hub') return false; // in a match, movement keys always work
  return a === $('chatinput') || a === $('name') || a === $('pass') || a === $('adminkey');
}

document.addEventListener('keydown', (e) => {
  if (isTyping()) return;
  const k = e.key.toLowerCase();
  if (k === 'enter') { e.preventDefault(); focusChat(); return; }
  if (k === 'm') { sfxMuted = !sfxMuted; toast(sfxMuted ? 'Sound muted (M)' : 'Sound on (M)'); return; }
  if (['w', 'a', 's', 'd', 'shift', 'e', ' '].includes(k)) keys.add(k === ' ' ? 'space' : k === 'shift' ? 'shift' : k);
});
document.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  keys.delete(k === ' ' ? 'space' : k === 'shift' ? 'shift' : k);
  if (k === 'enter') { $('chatinput').style.display = 'none'; $('chatinput').blur(); }
});
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement !== null;
  if (!pointerLocked) keys.clear();
});

const INPUT_MS = 50;
setInterval(() => {
  if (!selfId) return;
  const yaw = pointerLocked ? look.yaw : my.yaw;
  if (pointerLocked) my.yaw = look.yaw; else look.yaw = my.yaw;
  send({ t: 'input', k: Array.from(keys), yaw, pitch: look.pitch });
}, INPUT_MS);

/* ---------------- professional FX: sound, splash, vignette, touch ---------------- */
let actx = null, sfxMuted = false;
function ac() { if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } if (actx && actx.state === 'suspended') actx.resume(); return actx; }
function syncAudio() { const c = ac(); if (c) c.resume(); }
['mousedown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, syncAudio, { passive: true }));

function sfx(kind) {
  if (sfxMuted) return;
  const c = ac(); if (!c) return;
  const t0 = c.currentTime;
  const osc = (type, f, t, d, v, glide) => {
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t);
    if (glide) o.frequency.exponentialRampToValueAtTime(Math.max(1, glide), t + d);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + d + 0.03);
  };
  switch (kind) {
    case 'hurt': osc('sawtooth', 180, t0, 0.24, 0.22, 60); break;
    case 'hit': osc('square', 1100, t0, 0.07, 0.14, 320); osc('sawtooth', 480, t0 + 0.02, 0.09, 0.1, 220); break;
    case 'down': osc('square', 140, t0, 0.42, 0.2, 38); osc('sine', 70, t0, 0.42, 0.28, 40); break;
    case 'heart': osc('sine', 58, t0, 0.12, 0.38); osc('sine', 46, t0 + 0.19, 0.15, 0.38); break;
    case 'sting': osc('square', 480, t0, 0.2, 0.18, 200); osc('sine', 90, t0 + 0.06, 0.5, 0.28, 42); break;
    case 'escape': [523, 659, 784, 1046].forEach((f, i) => osc('triangle', f, t0 + i * 0.09, 0.24, 0.16)); break;
    case 'power': [392, 523, 659].forEach((f, i) => osc('triangle', f, t0 + i * 0.08, 0.28, 0.18)); break;
    case 'eclipse': osc('sine', 220, t0, 1.6, 0.25, 55); [330, 440].forEach((f, i) => osc('triangle', f, t0 + i * 0.12, 0.32, 0.14)); break;
  }
}

let splashT = null;
function showSplash(map, role) {
  const s = $('splash');
  s.innerHTML = '<h2>' + (map && map.mapName ? map.mapName.toUpperCase() : 'THE NIGHT') + '</h2>'
    + (role === 'killer'
      ? '<p>YOU ARE THE KILLER · SACRIFICE 3</p>'
      : '<p>REPAIR 5 GENERATORS &amp; ESCAPE<span class="fade"><br>SURVIVE THE ECLIPSE</span></p>');
  s.classList.add('show');
  if (splashT) clearTimeout(splashT);
  splashT = setTimeout(() => s.classList.remove('show'), 3400);
}
function hideSplash() { if (splashT) clearTimeout(splashT); $('splash').classList.remove('show'); }

function hurtFlash() {
  const v = $('vignette');
  v.classList.remove('flash'); void v.offsetWidth; v.classList.add('flash');
}

let lastHeart = 0;
setInterval(() => {
  if (matchState === 'hub' || role !== 'survivor') return;
  const me = targetPos.get(selfId) || my;
  let kd = 1e9;
  for (const p of matchPlayers) if (p.role === 'killer' && p.status !== 'dead' && p.status !== 'escaped') kd = Math.min(kd, dist2(me, p));
  const now2 = performance.now();
  if (kd < 12 * 12 && now2 - lastHeart > 950) { sfx('heart'); lastHeart = now2; }
}, 250);

/* mobile touch controls — left stick moves, right drag looks */
const touchOn = matchMedia('(pointer: coarse)').matches;
const TP = { stick: null, ox: 0, oy: 0, ex: 0, ey: 0, look: null, lx: 0, ly: 0 };
if (touchOn) $('touchpad').classList.add('on');
const stickEl = $('stick');
stickEl.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const t = e.changedTouches[0];
  TP.stick = t.identifier; TP.ox = t.clientX; TP.oy = t.clientY; TP.ex = 0; TP.ey = 0; syncAudio();
}, { passive: false });
stickEl.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) if (t.identifier === TP.stick) { TP.ex = t.clientX - TP.ox; TP.ey = t.clientY - TP.oy; }
}, { passive: false });
stickEl.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) if (t.identifier === TP.stick) TP.stick = null;
  TP.ex = 0; TP.ey = 0;
  keys.delete('w'); keys.delete('a'); keys.delete('s'); keys.delete('d');
});
document.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  if (t.clientX > innerWidth / 2 && TP.look == null && !e.target.closest('#touchpad button')) { TP.look = t.identifier; TP.lx = t.clientX; TP.ly = t.clientY; }
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (TP.look == null) return;
  e.preventDefault();
  for (const t of e.changedTouches) if (t.identifier === TP.look) {
    look.yaw -= (t.clientX - TP.lx) * 0.005;
    look.pitch = clamp(look.pitch - (t.clientY - TP.ly) * 0.005, -1.1, 0.5);
    my.yaw = look.yaw; TP.lx = t.clientX; TP.ly = t.clientY;
  }
}, { passive: false });
document.addEventListener('touchend', (e) => { for (const t of e.changedTouches) if (t.identifier === TP.look) TP.look = null; });
setInterval(() => {
  if (TP.stick == null) return;
  const len = Math.hypot(TP.ex, TP.ey);
  keys.delete('w'); keys.delete('a'); keys.delete('s'); keys.delete('d');
  if (len < 8) return;
  const f = FWD(my.yaw), r = RIGHT(my.yaw);
  const nx = TP.ex / len, nz = TP.ey / len;
  const fw = nx * f.x + nz * f.z, rt = nx * r.x + nz * r.z;
  if (fw > 0.35) keys.add('w'); else if (fw < -0.35) keys.add('s');
  if (rt > 0.35) keys.add('d'); else if (rt < -0.35) keys.add('a');
}, 40);
['taction', 'trun'].forEach(id => {
  const el = $(id);
  const key = id === 'taction' ? 'e' : 'shift';
  el.addEventListener('touchstart', (e) => { e.preventDefault(); keys.add(key); syncAudio(); }, { passive: false });
  el.addEventListener('touchend', () => keys.delete(key));
});

setInterval(() => {
  if (selfId && matchState !== 'hub') send({ t: 'ping', ts: performance.now() });
}, 2500);

/* ---------------- HUD ---------------- */
function setChip(id, txt) { $(id).textContent = txt; }

function updateHud() {
  const map = matchMap && matchMap.mapName ? ' · ' + matchMap.mapName : '';
  setChip('online', matchState !== 'hub' ? `Match ${matchMap ? matchMap.id : ''}${map} · Gen ${matchMap ? matchMap.gensDone : 0}/6` : `Hub · ${hubPlayers.length} souls · ${matchesActive} game${matchesActive === 1 ? '' : 's'}`);
  setChip('role', !role ? 'RECRUIT' : role === 'killer' ? 'KILLER' : 'SURVIVOR');
  const clkEl = $('clock');
  if (matchState !== 'hub' && matchMap && matchMap.clock != null) {
    const cl = Math.max(0, matchMap.clock);
    const mm = Math.floor(cl / 60), ss = Math.floor(cl % 60);
    clkEl.textContent = 'ECLIPSE ' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    clkEl.classList.toggle('low', cl <= 30);
    clkEl.style.display = '';
  } else clkEl.style.display = 'none';
  const pingEl = $('ping');
  if (selfId && matchState !== 'hub') {
    pingEl.textContent = 'Ping ' + (lastPing.rtt != null ? Math.round(lastPing.rtt) + 'ms' : '…');
    pingEl.style.display = '';
  } else pingEl.style.display = 'none';
  if (role === 'killer') {
    setChip('obj', 'Down survivors & hook them 3 TIMES to end the night');
    bars('stamina', my.sprint / 100 || 0);
    setChip('stats', `Sacrifices: ${(matchPlayers.filter(p => p.role === 'survivor' && (p.status === 'dead')).length)}/${matchPlayers.filter(p => p.role === 'survivor').length}`);
  } else if (role === 'survivor') {
    const Mm = matchPlayers.find(p => p.id === selfId);
    if (Mm && (Mm.status === 'dead' || Mm.status === 'escaped')) {
      const wat = matchPlayers.find(p => p.id === camFollowId);
      setChip('obj', wat ? `GHOST VIEW — watching ${wat.name}` : 'GHOST VIEW');
      setChip('stats', Mm.status === 'dead' ? 'Taken by the night' : 'You escaped');
      bars('hp', 0);
    } else {
      const powered = matchMap && matchMap.gatesPowered;
      const kname = (KILLERS[matchKillerId] || {}).name;
      const obj = powered ? 'OUTPUT GATES POWERED — open a gate & escape!'
        : (matchMap && matchMap.gensReady) ? 'All gens done — find the POWER SWITCH & flip it!'
        : `Repair generators… ${matchMap ? matchMap.gensDone : 0}/6`;
      setChip('obj', obj + (kname ? `  |  ${kname} hunts` : ''));
      setChip('stats', `HP ${'♥'.repeat(Math.max(0, Math.min(2, my.hp)))}${'♡'.repeat(Math.max(0, 2 - my.hp))}` + (my.hooks ? `  |  Hooked ${my.hooks}/3` : '') + (myItem ? `  |  [E] ${myItem === 'medkit' ? 'Medkit' : myItem === 'toolbox' ? 'Toolbox' : myItem === 'flash' ? 'Flashlight' : 'Hatch Key'}` : ''));
      bars('hp', (my.hp || 0) / 2);
    }
  } else {
    setChip('obj', 'Searching for players — match starts automatically…');
    bars('hp', 0); bars('stamina', 0);
  }
}

function bars(which, v) {
  let el = document.querySelector('.bar' + which);
  if (!el) {
    el = document.createElement('div');
    el.className = 'bar bar' + which;
    el.innerHTML = '<div></div>';
    $('bars').appendChild(el);
  }
  el.querySelector('div').style.width = (clamp(v, 0, 1) * 100) + '%';
}

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .6s'; setTimeout(() => el.remove(), 650); }, 4000);
  while ($('toasts').children.length > 5) $('toasts').firstChild.remove();
}

function chat(from, msg, admin) {
  const div = document.createElement('div');
  div.className = admin ? 'admin' : (from === 'FOG' ? 'sys' : 'c');
  div.innerHTML = `<span class="n">${from === 'FOG' ? '🌫 FOG' : from}:</span> ${msg}`.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  $('chatlog').appendChild(div);
  while ($('chatlog').children.length > 40) $('chatlog').firstChild.remove();
  $('chatlog').scrollTop = $('chatlog').scrollHeight;
}

function focusChat() {
  const ci = $('chatinput');
  if (ci.style.display === 'none') { ci.style.display = 'block'; ci.focus(); }
  else { ci.style.display = 'none'; ci.blur(); }
}
$('chatinput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = $('chatinput').value.trim();
    if (v) send({ t: 'chat', msg: v });
    $('chatinput').value = ''; $('chatinput').style.display = 'none'; $('chatinput').blur();
  }
});

/* ---------------- interact prompt ---------------- */
function updatePrompt() {
  const pr = $('prompt');
  if (matchState === 'hub' || role !== 'survivor' || !matchMap) { pr.style.display = 'none'; return; }
  if (my.status === 'dead' || my.status === 'escaped') { pr.style.display = 'none'; return; }
  let text = '';
  if (my.status === 'downed') text = 'Downed! A teammate can revive you…';
  else if (matchMap.gatesPowered) {
    for (const g of matchMap.gates) {
      if (!g.open && dist2(my, g) <= 2.3 * 2.3 * 1.4) text = g.open ? 'Walk through to escape!' : `HOLD E to open gate ${g.id}… ${(g.prog * 100).toFixed(0)}%`;
      if (g.open && pointInRect(my, g.zone.rect)) text = 'ESCAPE!';
    }
    if (!text) for (const g of matchMap.gens) if (!g.done && dist2(my, g) <= 2.1 * 2.1 * 1.4) text = 'Gate open — RUN!';
    if (!text) for (const g of matchMap.gates) if (!g.open && dist2(my, g) <= 2.3 * 2.3 * 1.9) text = `HOLD E to open gate ${g.id}… (takes ~10s)`;
  } else {
    // power switch: flip it to power the gates once all generators are done
    if (matchMap.power && matchMap.gensReady && !matchMap.power.on && dist2(my, matchMap.power) <= 2.3 * 2.3 * 1.5) {
      text = `HOLD E to flip the POWER SWITCH… ${Math.round((matchMap.power.prog || 0) * 100)}%`;
    }
    if (!text) {
      // nearest item pickup
      if (!text) for (const it of (matchMap.items || [])) if (!it.taken && dist2(my, it) <= 2.0 * 2.0 * 1.5) text = `E to grab ${it.name}`;
      if (!text) for (const pk of (matchMap.keys || [])) if (myItem === 'key' && !pk.open && dist2(my, pk) <= 2.4 * 2.4 * 1.4) text = 'E to unlock the hatch & escape!';
      for (const g of matchMap.gens) if (!g.done && dist2(my, g) <= 2.1 * 2.1 * 1.4) text = `HOLD E to repair generator… ${(g.prog * 100).toFixed(0)}%`;
      if (!text) for (const p of matchPlayers) if (p.id !== selfId && p.status === 'downed' && dist2(my, p) <= 2.2 * 2.2 * 1.4) {
        const prog = p.progress || 0;
        text = `HOLD E to revive ${p.name}… ${(prog / 5 * 100).toFixed(0)}%`;
      }
    }
  }
  // held-item usage hint
  if (role === 'survivor' && myItem && my.status !== 'downed' && my.status !== 'dead' && my.status !== 'escaped' && !text) {
    text = 'E to use ' + (ITEM_COLORS[myItem] ? myItem : myItem) + (myItem === 'key' ? ' (at the hatch)' : '');
  }
  pr.style.display = text ? 'block' : 'none';
  if (text) pr.textContent = text;
}

function pointInRect(p, r) { return p.x >= r.x && p.x <= r.x + r.w && p.z >= r.z && p.z <= r.z + r.d; }

/* ---------------- match/player state ---------------- */
function ifMenu() {
  if (matchState === 'hub') return;
  if (matchMap && matchMap.killerId) matchKillerId = matchMap.killerId;
  // refresh my info (position comes from server so interactions stay honest)
  const m = matchPlayers.find(p => p.id === selfId);
  if (m) {
    const pprev = my.status, hprev = my.hp;
    my.hp = m.hp; my.status = m.status; my.sprint = m.sprint != null ? m.sprint : my.sprint;
    my.hooks = m.hooks != null ? m.hooks : my.hooks;
    my.x = m.x; my.y = m.y; my.z = m.z;
    myItem = m.item || null;
    if (m.role === 'survivor' && m.status !== pprev) {
      if (m.status === 'downed') { sfx('down'); hurtFlash(); }
      else if (m.status === 'injured' && hprev === 2) { sfx('hurt'); hurtFlash(); }
      else if (m.status === 'escaped') { sfx('escape'); hurtFlash(); }
      else if (m.status === 'dead') { sfx('sting'); }
    } else if (m.hp < hprev && m.status === 'injured') { sfx('hurt'); hurtFlash(); }
  }
  const _nowT = performance.now();
  const isNewFrame = _nowT - lastServerT > 20; // a fresh server state, not a same-frame re-call
  if (isNewFrame) lastServerT = _nowT;
  for (const p of matchPlayers) {
    const e = ensurePlayer(p);
    const cur = targetPos.get(p.id);
    if (isNewFrame && cur && !cur.hub) prevPos.set(p.id, { x: cur.x, y: cur.y, z: cur.z });
    targetPos.set(p.id, { x: p.x, y: p.y, z: p.z, yaw: p.yaw, status: p.status, hp: p.hp, carrier: p.carrier });
  }
  // remove gone players
  const seen = new Set(matchPlayers.map(p => p.id));
  playerMeshes.forEach((_, id) => { if (!seen.has(id) && id !== selfId) { const e = playerMeshes.get(id); if (e) { matchGroup && matchGroup.remove(e.group); } playerMeshes.delete(id); targetPos.delete(id); prevPos.delete(id); } });
}

let hubCount = null;

function endMatch(result, mine) {
  $('end').style.display = 'flex';
  const h = $('end'); h.innerHTML = '';
  const t = document.createElement('h1');
  if (result.winner === 'survivors') { t.textContent = 'YOU ESCAPED'; t.style.color = '#5dff8a'; }
  else if (result.winner === 'killer') { t.textContent = 'FEAR WINS'; t.style.color = '#ff5a4e'; }
  else { t.textContent = 'A DRAW IN THE DARK'; t.style.color = '#f4c25a'; }
  h.appendChild(t);
  const p = document.createElement('p');
  p.textContent = `${result.esc} escape${result.esc === 1 ? '' : 's'} · ${result.kills} sacrifice${result.kills === 1 ? '' : 's'} — the night on ${result.map || 'the wrong side of the fog'} lasted ${result.duration || '?'}s${result.eclipse ? ' · ended by the eclipse' : ''}`;
  h.appendChild(p);
  if (result.escaped && result.escaped.length) {
    const el = document.createElement('p');
    el.style.color = '#5dff8a'; el.style.fontSize = '14px';
    el.textContent = 'Escaped: ' + result.escaped.join(', ');
    h.appendChild(el);
  }
  if (result.sacrifices && result.sacrifices.length) {
    const sl = document.createElement('p');
    sl.style.color = '#ff7a6e'; sl.style.fontSize = '14px';
    sl.textContent = 'Fallen: ' + result.sacrifices.join(', ');
    h.appendChild(sl);
  }
  const b = document.createElement('div');
  b.className = 'big';
  b.textContent = mine.role === 'killer'
    ? (mine.win ? '+1 Killer Victory' : '+1 Match Played')
    : (mine.escaped ? '+1 Escape!' : mine.dead ? 'You fell to the night' : '+1 Match Played');
  h.appendChild(b);
  const c = document.createElement('p');
  c.style.color = '#6d7a99'; c.style.fontSize = '13px'; c.style.marginTop = '18px';
  h.appendChild(c);
  if (hubCount) clearInterval(hubCount);
  let n = 6;
  hubCount = setInterval(() => {
    c.textContent = n > 0 ? `Returning to hub in ${n}s…` : 'Returning…';
    if (--n < 0) { clearInterval(hubCount); hubCount = null; }
  }, 1000);
}

/* ---------------- minimap ---------------- */
function drawMinimap() {
  const cv = $('mm'); if (cv.style.display === 'none' || !matchMap) return;
  const ctx = cv.getContext('2d');
  const S = 90, PX = cv.width = cv.height = 170;
  const sc = (v) => (v + S / 2) * (PX / S);
  ctx.clearRect(0, 0, PX, PX);
  ctx.strokeStyle = '#3a4a66'; ctx.strokeRect(1, 1, PX - 2, PX - 2);
  for (const hk of matchMap.hooks) { ctx.fillStyle = '#b03a2f'; ctx.fillRect(sc(hk.x) - 2, sc(hk.z) - 2, 4, 4); }
  for (const g of matchMap.gens) { ctx.fillStyle = g.done ? '#3dff7a' : '#ffd24e'; ctx.beginPath(); ctx.arc(sc(g.x), sc(g.z), 3, 0, 7); ctx.fill(); }
  for (const g of matchMap.gates) { ctx.fillStyle = g.open ? '#5dff8a' : '#6b8fb3'; ctx.beginPath(); ctx.arc(sc(g.x), sc(g.z), 4, 0, 7); ctx.fill(); }
  const me = targetPos.get(selfId) || my;
  for (const p of matchPlayers) {
    if (p.id !== selfId) {
      ctx.fillStyle = p.role === 'killer' ? '#ff3a1a' : (isDead(p.status) ? '#555' : '#2cc8e8');
      ctx.beginPath(); ctx.arc(sc(p.x), sc(p.z), p.role === 'killer' ? 4 : 2.6, 0, 7); ctx.fill();
    }
  }
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(sc(me.x), sc(me.z), 3, 0, 7); ctx.fill();
  ctx.strokeStyle = '#ffffff'; ctx.beginPath(); ctx.arc(sc(me.x), sc(me.z), 5, 0, 7); ctx.stroke();
}

/* ---------------- log in ---------------- */
let authMode = 'login'; // 'login' | 'register'
function toggleAuthMode() {
  authMode = authMode === 'login' ? 'register' : 'login';
  const register = authMode === 'register';
  $('authmodetoggle').textContent = register ? 'Already have an account? LOG IN' : 'New here? REGISTER';
  $('pass').placeholder = register ? 'Create a password' : 'Password';
  $('join').textContent = register ? 'CREATE ACCOUNT' : 'ENTER THE FOG';
  $('email').style.display = register ? 'block' : 'none';
}
$('authmodetoggle').addEventListener('click', toggleAuthMode);
$('join').addEventListener('click', () => {
  const n = $('name').value.trim();
  const pw = $('pass').value;
  const btn = $('join');
  if (n.length < 2) { $('authmsg').textContent = 'Pick a name (2-16 chars).'; return; }
  if (pw.length === 0) { $('authmsg').textContent = authMode === 'register' ? 'Create a password.' : 'Enter your password.'; return; }
  if (authMode === 'register') {
    const em = $('email').value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { $('authmsg').textContent = 'Enter a valid email for password recovery.'; return; }
  }
  btn.disabled = true;
  $('authmsg').textContent = 'Sending...';
  connect(n, pw);
});
['name', 'pass', 'email', 'adminkey'].forEach(id => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); }));

/* ---------------- tip / support ---------------- */
function showTip() {
  if (!TIP_URL) return;
  $('tip').style.display = 'flex';
  $('tipmsg').textContent = 'Support the devs on Ko-fi — every tip keeps the fog rolling!';
}
function hideTip() { $('tip').style.display = 'none'; }
$('tiplink').addEventListener('click', showTip);
$('tipclose').addEventListener('click', hideTip);
$('tipback').addEventListener('click', (e) => { e.preventDefault(); hideTip(); });
$('tipopen').addEventListener('click', () => { if (TIP_URL) window.open(TIP_URL, '_blank'); });
// Hidden entirely (not just inert) when no tip page is configured.
if (!TIP_URL) { $('tiplink').style.display = 'none'; }

/* ---------------- password reset ---------------- */
function showReset() {
  $('login').style.display = 'none';
  $('reset').style.display = 'flex';
  $('rmsg').textContent = '';
  $('rcode').value = '';
}
function showLoginFromReset() {
  $('reset').style.display = 'none';
  $('login').style.display = 'flex';
}
$('forgotlink').addEventListener('click', (e) => { e.preventDefault(); showReset(); });
$('rback').addEventListener('click', (e) => { e.preventDefault(); showLoginFromReset(); });
$('rrequest').addEventListener('click', () => {
  const ident = $('rident').value.trim();
  if (!ident) { $('rmsg').textContent = 'Enter your username or email.'; return; }
  $('rmsg').textContent = 'Sending code...';
  send({ t: 'requestReset', name: ident });
});
$('rdo').addEventListener('click', () => {
  const code = $('rcode').value.trim();
  const pw = $('rpass').value;
  const name = $('rident').value.trim();
  if (!code) { $('rmsg').textContent = 'Enter the reset code from your email.'; return; }
  if (pw.length === 0) { $('rmsg').textContent = 'Enter a new password.'; return; }
  $('rmsg').textContent = 'Resetting...';
  send({ t: 'doReset', name, code, pass: pw });
});
['rident', 'rcode', 'rpass'].forEach(id => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('rdo').click(); }));

// outfit picker
(function buildOutfitPicker() {
  const wrap = $('outfit-swatches');
  OUTfits.forEach((o, i) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'swatch' + (i === pickedOutfit ? ' sel' : '');
    sw.style.background = '#' + ('00000' + o.body.toString(16)).slice(-6);
    sw.title = o.name;
    sw.addEventListener('click', (e) => {
      e.stopPropagation();
      pickedOutfit = i;
      document.querySelectorAll('#outfit-swatches .swatch').forEach((x) => x.classList.remove('sel'));
      sw.classList.add('sel');
      $('outfit-label').querySelector('b').textContent = o.name;
    });
    wrap.appendChild(sw);
  });
})();

/* ---------------- logout + saved-login auto reconnect ---------------- */
function doLogout() {
  clearSession();
  autoReconnect = false; reconnectTries = 0;
  try { if (ws) ws.close(); } catch {}
  selfId = null; selfName = null; isAdmin = false;
  $('logoutbtn').style.display = 'none';
  $('login').style.display = 'flex';
  $('hint').style.display = 'none';
}
$('logoutbtn').addEventListener('click', doLogout);

// Toggle the Logout button whenever auth state changes.
const _origStart = start;
function start() {
  if ($('logoutbtn')) $('logoutbtn').style.display = '';
  return _origStart();
}

(function autoLogin() {
  const saved = loadSession();
  if (!saved || !saved.name) return;           // nothing remembered
  // Pre-fill the form with the saved login so it's visible if reconnect fails.
  $('name').value = saved.name || '';
  $('pass').value = saved.pass || '';
  $('email').value = saved.email || '';
  $('adminkey').value = saved.admin || '';
  if (typeof pickedOutfit === 'number' && saved.outfit != null) pickedOutfit = saved.outfit;
  authMode = 'login'; $('authmodetoggle').textContent = 'New here? REGISTER';
  $('join').textContent = 'ENTER THE FOG';
  $('email').style.display = 'none';
  autoReconnect = true; reconnectTries = 0;
  connect(null, null, 'login');                // silent auto login
})();