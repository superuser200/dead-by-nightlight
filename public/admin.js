'use strict';
/* DEAD BY NIGHTLIGHT — admin/ban tool client (talks to the game server over WebSocket) */
const $ = (id) => document.getElementById(id);
let ws = null, connected = false;

function setStatus(txt, on) {
  const s = $('status');
  s.textContent = txt;
  s.className = 'badge' + (on ? ' on' : '');
}

function wire() {
  $('go').onclick = connect;
  $('key').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  $('banUser').onclick = () => {
    const name = $('bname').value.trim();
    if (!name) return;
    cmd({ op: 'banUser', name, reason: $('breason').value.trim() || 'violating rules', durMin: Number($('bdur').value) });
    $('bname').value = '';
  };
  $('banIp').onclick = () => {
    const ip = $('bip').value.trim();
    if (!ip) return;
    cmd({ op: 'banIp', ip, reason: $('bipr').value.trim() || 'violating rules', durMin: 0 });
    $('bip').value = '';
  };
}

function cmd(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'admin', ...msg }));
}

function connect() {
  const key = $('key').value.trim();
  if (!key) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name: 'Admin-' + Math.floor(Math.random() * 9999), admin: key }));
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch { } };
  ws.onclose = () => { connected = false; $('app').style.pointerEvents = 'none'; $('app').style.opacity = '.4'; setStatus('disconnected', false); };
}

function handle(msg) {
  switch (msg.t) {
    case 'auth':
      if (msg.ok && msg.admin) {
        connected = true;
        $('app').style.pointerEvents = 'auto'; $('app').style.opacity = '1';
        setStatus('connected as ' + msg.name, true);
        cmd({ op: 'list' }); cmd({ op: 'log' });
      } else { setStatus('auth failed — bad key', false); connected = false; }
      break;
    case 'adminSnapshot':
      renderPlayers(msg.online);
      renderBans(msg.bans);
      break;
    case 'adminLog':
      renderLog(msg.log);
      break;
    case 'cheat':
      addLog(msg.entry, true);
      break;
    case 'toast':
      addLog({ kind: 'admin note: ' + msg.msg }, true);
      break;
  }
}

function renderPlayers(list) {
  const tb = $('players');
  tb.innerHTML = '<tr><th>Name</th><th>State</th><th>Role</th><th>IP</th><th></th></tr>';
  for (const p of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(p.name)}</td>
      <td>${p.state}${p.queued ? ' (queued)' : ''}</td>
      <td class="${p.role ? (p.role === 'killer' ? 'role-killer' : 'role-survivor') : ''}">${p.role || (p.admin ? 'admin' : 'hub')}</td>
      <td>${esc(p.ip)}</td>
      <td><button class="btn small" data-kick="${esc(p.name)}">Kick</button> <button class="btn small" data-ban="${esc(p.name)}">Ban</button></td>`;
    tb.appendChild(tr);
  }
}
document.addEventListener('click', (e) => {
  const k = e.target.getAttribute && e.target.getAttribute('data-kick');
  const b = e.target.getAttribute && e.target.getAttribute('data-ban');
  if (k) cmd({ op: 'kick', name: k });
  if (b) { $('bname').value = b; $('bdur').value = '1440'; }
});

function renderBans(bans) {
  const ut = $('busers');
  ut.innerHTML = '<tr><th>User</th><th>Reason</th><th>Until</th><th></th></tr>';
  for (const [name, v] of Object.entries(bans.users || {})) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(name)}</td><td>${esc(v.reason)}</td><td>${i(v.until, v.at)}</td>
      <td><button class="btn small" data-unban="${esc(name)}">UNBAN</button></td>`;
    ut.appendChild(tr);
  }
  const it = $('bips');
  it.innerHTML = '<tr><th>IP</th><th>Reason</th><th>Until</th><th></th></tr>';
  for (const [ip, v] of Object.entries(bans.ips || {})) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(ip)}</td><td>${esc(v.reason)}</td><td>${i(v.until, v.at)}</td>
      <td><button class="btn small" data-unip="${esc(ip)}">UNBAN</button></td>`;
    it.appendChild(tr);
  }
}
document.addEventListener('click', (e) => {
  const u = e.target.getAttribute && e.target.getAttribute('data-unban');
  const ip = e.target.getAttribute && e.target.getAttribute('data-unip');
  if (u) cmd({ op: 'unbanUser', name: u });
  if (ip) cmd({ op: 'unbanIp', ip });
});

function renderLog(log) {
  const box = $('log'); box.innerHTML = '';
  if (!log.length) box.innerHTML = '<div style="color:#5f6f92">No incidents yet — clean night.</div>';
  for (const e of log) box.appendChild(mkEntry(e));
}
function addLog(e, newest) {
  const box = $('log');
  if (newest) box.insertBefore(mkEntry(e), box.firstChild); else box.appendChild(mkEntry(e));
  while (box.children.length > 300) box.lastChild.remove();
}
function mkEntry(e) {
  const div = document.createElement('div');
  const when = e.t ? new Date(e.t).toLocaleTimeString() + '  ' : '';
  div.textContent = when + (e.kind ? `⚡ ${e.kind}` : `${e.name} (${e.ip})`) + (e.reason ? ` — ${e.reason}` : '') + (e.rate ? ` (${e.rate}/s)` : '');
  if (e.kind === 'auto-ban' || e.kind && e.kind.includes('ban')) div.className = 'logbad';
  return div;
}

function i(until, at) {
  const now = Date.now();
  if (until === 0) return 'Permanent';
  const mins = Math.round((until - now) / 60000);
  return mins > 0 ? mins + 'm left' : 'expired';
}
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

wire();