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
let matchMap = null;         // { gens, gates, hooks }
let matchState = 'hub';      // 'hub' | 'match' | 'done'
let hubPlayers = [];
let matchPlayers = [];
let queueSize = 0, matchesActive = 0;

function connect(token) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: $('name').value.trim(), admin: token || '' }));
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch { } };
  ws.onclose = () => {
    toast('Connection lost. Refresh to rejoin.', 'bad');
    $('login').style.display = 'flex';
  };
}

function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function handle(msg) {
  switch (msg.t) {
    case 'auth':
      if (msg.ok) {
        selfId = msg.id; selfName = msg.name; isAdmin = !!msg.admin;
        $('login').style.display = 'none';
        $('hint').style.display = 'block';
        start();
      } else $('authmsg').textContent = msg.msg;
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
      role = msg.match.role; matchMap = msg.match.map; matchState = 'running';
      enterMatch(); toast(role === 'killer' ? 'You are THE KILLER. Hunt them all.' : 'You are a SURVIVOR. Repair 5 generators & escape!', role === 'killer' ? 'bad' : 'good');
      break;
    case 'returnHub':
      role = null; matchState = 'hub'; matchMap = null; matchPlayers = [];
      leaveMatch(); toast('Back at the survivor hub.');
      break;
    case 'matchEnd':
      endMatch(msg.result, msg.mine);
      break;
    case 'toast': toast(msg.msg); break;
    case 'chat': chat(msg.from, msg.msg, msg.admin); break;
    case 'queue': queueSize = msg.size; updateHud(); break;
    case 'queueInfo': queueSize = msg.size; matchesActive = msg.matches; updateHud(); break;
    case 'ejected': toast(msg.msg, 'bad'); break;
  }
}

/* ---------------- three.js scene ---------------- */
let scene, camera, renderer;
let hubGroup = null, matchGroup = null;
let playerMeshes = new Map();   // id -> {group, nameSprite, mats...}
let genMeshes = new Map(), hookMeshes = new Map(), gateMeshes = new Map();
let targetPos = new Map();      // id -> {x,z,y,yaw,status,carrier,hp}

const isDowned = (s) => s === 'downed';
const isDead = (s) => s === 'dead' || s === 'escaped';

const BASE_SKY = 0x060a14, BASE_FOG = 0x0a0f1e;
const THEMES = {
  hollow: { floor: 0x141a26, grid: 0x1c2434, tree: [0x16212e, 0x1c3324, 0x2a3440] },
  farm:   { floor: 0x151b10, grid: 0x202a18, tree: [0x1c2a16, 0x223820, 0x3a3320] },
  graveyard: { floor: 0x161722, grid: 0x22222f, tree: [0x1d1f2c, 0x2a2b3a, 0x34323f] },
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
    genMeshes.set(g.id, { grp, core: grp.children[4] });
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

function leaveMatch() {
  if (matchGroup) { scene.remove(matchGroup); matchGroup = null; }
  playerMeshes.forEach((o) => scene.remove(o.group));
  playerMeshes.clear(); targetPos.clear();
  $('mm').style.display = 'none';
  $('end').style.display = 'none';
  $('prompt').style.display = 'none';
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
  const group = new THREE.Group();
  const bodyCol = isKiller ? 0x7a1f18 : 0x2f7f8f;
  const skinCol = isKiller ? 0x3a2a20 : 0xd9b48f;

  const limb = (mat) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.55, 8), mat);
    m.position.y = -0.28; // pivot at shoulder/hip
    return m;
  };
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.78, 0.38), new THREE.MeshLambertMaterial({ color: bodyCol }));
  body.position.y = 1.05;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), new THREE.MeshLambertMaterial({ color: skinCol }));
  head.position.y = 1.68;

  const armMat = new THREE.MeshLambertMaterial({ color: bodyCol });
  const legMat = new THREE.MeshLambertMaterial({ color: 0x26303f });
  const armL = limb(armMat), armR = limb(armMat);
  armL.position.x = -0.42; armR.position.x = 0.42;
  armL.position.y = 1.62; armR.position.y = 1.62;
  const legL = limb(legMat), legR = limb(legMat);
  legL.position.x = -0.17; legR.position.x = 0.17;
  legL.position.y = 0.68; legR.position.y = 0.68;

  group.add(body, head, armL, armR, legL, legR);
  const name = makeNameSprite(p.name);
  group.add(name);

  let baseScale = 1;
  if (isKiller) {
    baseScale = 1.3;
    const e1 = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.07, 0.05), new THREE.MeshBasicMaterial({ color: 0xff2a0a }));
    const e2 = e1.clone();
    e1.position.set(-0.11, 1.72, 0.23); e2.position.set(0.11, 1.72, 0.23);
    group.add(e1); group.add(e2);
    head.material = new THREE.MeshLambertMaterial({ color: 0x101014 });
    head.scale.setScalar(1.15);
    name.position.y = 3.05;
  } else {
    name.position.y = 2.35;
  }
  group.scale.set(baseScale, baseScale, baseScale);

  entry = { group, name, isKiller, armL, armR, legL, legR, moving: null };
  playerMeshes.set(p.id, entry);
  if (matchState === 'match' && matchGroup) matchGroup.add(group);
  else scene.add(group);
  return entry;
}

function setPose(entry, moving, dead, downed) {
  if (!entry) return;
  const a = entry.isKiller ? 0.4 : 0.55;
  if (moving) entry.moving = moving;
  if (dead || downed) {
    entry.armL.rotation.z = Math.PI / 2; entry.armR.rotation.z = -Math.PI / 2;
    entry.legL.rotation.x = 0; entry.legR.rotation.x = 0;
    entry.group.rotation.z = Math.PI / 2;
    return;
  }
  entry.group.rotation.z = 0;
  if (entry.moving) {
    const s = Math.sin(performance.now() / 90) * a;
    entry.armL.rotation.x = s; entry.armR.rotation.x = -s;
    entry.legL.rotation.x = -s; entry.legR.rotation.x = s;
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
    const prevX = g.position.x, prevZ = g.position.z;
    g.position.x += (t.x - g.position.x) * 0.25 * delta;
    g.position.z += (t.z - g.position.z) * 0.25 * delta;
    g.position.y += (t.y - g.position.y) * 0.4 * delta;
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
      const moving = Math.hypot(g.position.x - prevX, g.position.z - prevZ) > 0.001;
      setPose(entry, moving, false, false);
    } else {
      setPose(entry, false, dead || (downed && isYou && t.status === 'dead'), downed);
    }
  });

  // camera follow self
  const me = targetPos.get(selfId) || my;
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
    }
    for (const g of matchMap.gates) {
      const gm = gateMeshes.get(g.id);
      if (gm) gm.rotation.y = g.open ? 0 : 0;
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

function isTyping() { return document.activeElement === $('chatinput') || document.activeElement === $('name'); }

document.addEventListener('keydown', (e) => {
  if (isTyping()) return;
  const k = e.key.toLowerCase();
  if (k === 'enter') { e.preventDefault(); focusChat(); return; }
  if (k === 'q') { if (e.repeat) return; send({ t: 'queue' }); return; }
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

/* ---------------- HUD ---------------- */
function setChip(id, txt) { $(id).textContent = txt; }

function updateHud() {
  const map = matchMap && matchMap.mapName ? ' · ' + matchMap.mapName : '';
  setChip('online', matchState !== 'hub' ? `Match ${matchMap ? matchMap.id : ''}${map} · Gen ${matchMap ? matchMap.gensDone : 0}/5` : `Hub · ${hubPlayers.length} souls · queue ${queueSize}|${matchesActive === 1 ? 'game' : 'games'}`);
  setChip('role', !role ? 'RECRUIT' : role === 'killer' ? 'KILLER' : 'SURVIVOR');
  if (role === 'killer') {
    setChip('obj', 'Hunt & sacrifice survivors (3+ to win)');
    bars('stamina', my.sprint / 100 || 0);
    setChip('stats', `Sacrifices: ${(matchPlayers.filter(p => p.role === 'survivor' && (p.status === 'dead')).length)}/${matchPlayers.filter(p => p.role === 'survivor').length}`);
  } else if (role === 'survivor') {
    const powered = matchMap && matchMap.gatesPowered;
    setChip('obj', powered ? 'OUTPUT GATES POWERED — open a gate & escape!' : `Repair generators… ${matchMap ? matchMap.gensDone : 0}/5`);
    setChip('stats', `HP ${'♥'.repeat(Math.max(0, Math.min(2, my.hp)))}${'♡'.repeat(Math.max(0, 2 - my.hp))}`);
    bars('hp', (my.hp || 0) / 2);
  } else {
    setChip('obj', 'Press Q to queue for a match — first in gets the knife');
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
  if (matchState !== 'match' || role !== 'survivor' || !matchMap) { pr.style.display = 'none'; return; }
  let text = '';
  if (my.status === 'downed') text = 'Downed! A teammate can revive you…';
  else if (matchMap.gatesPowered) {
    for (const g of matchMap.gates) {
      if (!g.open && dist2(my, g) <= 2.3 * 2.3 * 1.4) text = g.open ? 'Walk through to escape!' : `HOLD E to open gate ${g.id}… ${(g.prog * 100).toFixed(0)}%`;
      if (g.open && pointInRect(my, g.zone.rect)) text = 'ESCAPE!';
    }
    if (!text) for (const g of matchMap.gens) if (!g.done && dist2(my, g) <= 2.1 * 2.1 * 1.4) text = 'Gate open — RUN!';
    if (!text) for (const g of matchMap.gates) if (!g.open && dist2(my, g) <= 2.3 * 2.3 * 1.9) text = `HOLD E to open gate ${g.id}…`;
  } else {
    for (const g of matchMap.gens) if (!g.done && dist2(my, g) <= 2.1 * 2.1 * 1.4) text = `HOLD E to repair generator… ${(g.prog * 100).toFixed(0)}%`;
    if (!text) for (const p of matchPlayers) if (p.id !== selfId && p.status === 'downed' && dist2(my, p) <= 2.2 * 2.2 * 1.4) {
      const prog = p.progress || 0;
      text = `HOLD E to revive ${p.name}… ${(prog / 5 * 100).toFixed(0)}%`;
    }
  }
  pr.style.display = text ? 'block' : 'none';
  if (text) pr.textContent = text;
}

function pointInRect(p, r) { return p.x >= r.x && p.x <= r.x + r.w && p.z >= r.z && p.z <= r.z + r.d; }

/* ---------------- match/player state ---------------- */
function ifMenu() {
  if (matchState !== 'match') return;
  // refresh my info (position comes from server so interactions stay honest)
  const m = matchPlayers.find(p => p.id === selfId);
  if (m) {
    my.hp = m.hp; my.status = m.status; my.sprint = m.sprint != null ? m.sprint : my.sprint;
    my.x = m.x; my.y = m.y; my.z = m.z;
  }
  for (const p of matchPlayers) {
    const e = ensurePlayer(p);
    targetPos.set(p.id, { x: p.x, y: p.y, z: p.z, yaw: p.yaw, status: p.status, hp: p.hp, carrier: p.carrier });
  }
  // remove gone players
  const seen = new Set(matchPlayers.map(p => p.id));
  playerMeshes.forEach((_, id) => { if (!seen.has(id) && id !== selfId) { const e = playerMeshes.get(id); if (e) { matchGroup && matchGroup.remove(e.group); } playerMeshes.delete(id); targetPos.delete(id); } });
}

function endMatch(result, mine) {
  $('end').style.display = 'flex';
  const t = document.createElement('span');
  const h = $('end');
  const tmp = document.createElement('h1');
  if (result.winner === 'survivors') { tmp.textContent = 'YOU ESCAPED'; tmp.style.color = '#5dff8a'; }
  else if (result.winner === 'killer') { tmp.textContent = 'FEAR WINS'; tmp.style.color = '#ff5a4e'; }
  else { tmp.textContent = 'A DRAW IN THE DARK'; tmp.style.color = '#f4c25a'; }
  h.appendChild(tmp);
  const p = document.createElement('p');
  p.textContent = `Escapes: ${result.esc} · Sacrifices: ${result.kills} — match ${result.killer} hosted the night`;
  h.appendChild(p);
  const b = document.createElement('div');
  b.className = 'big';
  b.textContent = mine.role === 'killer'
    ? (mine.win ? '+1 Killer Victory' : '+1 Match Played')
    : (mine.escaped ? '+1 Escape!' : mine.dead ? 'You fell to the night' : '+1 Match Played');
  h.appendChild(b);
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
$('join').addEventListener('click', () => {
  const n = $('name').value.trim();
  if (n.length < 2) { $('authmsg').textContent = 'Pick a name (2-16 chars).'; return; }
  $('join').disabled = true;
  connect($('adminkey').value.trim());
});
['name', 'adminkey'].forEach(id => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); }));