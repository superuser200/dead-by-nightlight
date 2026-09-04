# DEAD BY NIGHTLIGHT — AI DEV AGENDA (self-driving backlog)

This file is the "AI professional's" self-running roadmap. On every session:
1. Read this file.
2. Do the next un-done item (or the top-level goal).
3. Push to GitHub (cloud auto-redeploys → game updates, no user action).
4. Update this file: mark done items, write the next fresh ideas at the bottom.
5. Never ask the user what to do — just improve. Only stop if something genuinely blocks.

Live URL / health: https://zvtwi1wwzriw-production-tm7xzx3j.us-central1.suga.run/healthz
Repo: github.com/superuser200/dead-by-nightlight (branch main, remote reset to clean)

----------------------------------------------------------------------------
## CORE MISSION
Keep the game alive 24/7 on the free cloud, and make it measurably more fun /
longer-lasting with every batch. Match = 1 killer vs up to 4 queues (killer = 1st
queue, rest survivor). Bots fill matches so a solo player always gets a game.

## HOW TO VERIFY
- Local: `$env:ADMIN_TOKEN="smoketest"; $env:NODE_ENV="development"`, start
  `server/server.js`, run `node test/smoke.js` (13 checks must all PASS).
- Client regressions: `node test/client-load.js` (7 checks) — loads the real
  client.js headlessly and asserts it initializes + ensurePlayer builds both roles.
  ALWAYS run this too (the server smoke suite can never catch client load/render
  crashes like the pickedOutfit / name-sprite bugs).
- Then `NODE_ENV=production` for a live-feel match (bots turn on via IS_LIVE gate).
- Push commit → wait ~80-90s → check `/healthz` and fetch `/client.js` / `/`
  to confirm the new markers are live.
- Git identity: `-c user.name="sugadev" -c user.email="suga@example.com"`.
- ALWAYS `node --check` server.js AND client.js before committing.

----------------------------------------------------------------------------
## STATUS (latest: 2026-09)

### DONE
- Learning AI bots (solo insta-match), maps: Split-Field, The Graveyard, The Hollow,
  The Asylum. Matchmaker bots fill; stale idle bots are reused so matches always form.
- Eclipse timer (240s) + escape, richer match end result, bot skill tiers.
- WebAudio sfx (hurt/hit/down/heart/escape/power/eclipse), splash, hurt vignette,
  mobile touch controls, ping chip, ghost spectate, gen progress bar verticals.
- BOT KILLER full loop: chase → down → pick up → carry → hook → sacrifice (verified live).
- Fixed: bot walkTo navigation yaw bug, carried survivors bleeding out instantly,
  killer pick radius, stale-bot steal of matchmaking, player-not-moving on startup
  (login input focus swallowing WASD), Discord link.
- SEO: meta tags, sitemap.xml, robots.txt; Google Search Console verified via
  google79d2180f87c8c2c7.html; index requested.
- CONTENT BATCH: 4 killer archetypes (Ravager, Brute=one-hit-down+slow,
  Whisper=fast, Umbra) w/ unique weapon meshes + stat twists; 8 survivor outfits +
  login outfit picker; The Asylum map; killer identity in HUD.
- CRITICAL FIX: `ensurePlayer` referenced an undefined `name` sprite (deleted in the
  41125ad refactor while its `name.position.y` uses stayed) → ReferenceError on every
  state frame broke the whole WS handler → NO players ever rendered + per-frame error
  stack felt like lag. Restored `const name = makeNameSprite(p.name); group.add(name);`.
  (Smoke suite couldn't catch this — it's client-JS only, no browser.)
- CRITICAL FIX #2 (root cause of "can't move / can't be seen after pressing Q"):
  `pickedOutfit` was USED (outfit picker IIFE runs at load + connect()) but NEVER
  declared. In strict mode the IIFE threw `ReferenceError: pickedOutfit is not
  defined` AT SCRIPT LOAD → the ENTIRE client.js aborted → no input listeners, no
  renderer, no rendering at all. Added `let pickedOutfit = 0;`. Verified via headless
  vm harness that client.js now LOADS and `ensurePlayer` works for survivor+killer.
  LESSON: keep a headless client load harness (client_harness.js pattern) since the
  smoke suite (server-only) can never catch client load/render regressions.
- ITEM SYSTEM (server+client): Medkit/Toolbox/Flashlight/Key pickups spawn at the
  edges (4+nplayers, ≤8), Hatch + Key escape, medkit heals, toolbox 1.9x repair,
  flashlight stuns killer 2.5s, sfx + prompts + held-item HUD. matchView verified live
  (types present); full pickup->use flow pending live sanity check.
- EXIT SYSTEM REWORK (power switch + gates + vault walls): exit no longer auto-powers
  on 5 gens. Now 6 generators must be repaired → survivors find & hold E to flip a
  POWER SWITCH (~5s) → gates become powered → hold E at a gate (~10s, `dt*0.1`) to open
  & escape. Added jumpable LOW VAULT WALLS to all 4 maps (survivors vault over with
  space when airborne ≥ wall height; killers CANNOT jump so they can't follow); real
  wall collision in `moveEntity`/`wallBlocked`. Survivor bots: repair → flip switch →
  open gate. `matchView` now carries walls/power/gensReady for the client to render the
  switch + walls + prompts/HUD. Verified: smoke 13/13 + client-load 7/7 + unit check of
  wallBlocked (grounded survivor blocked, airborne survivor passes, killer always blocked).
- BUGFIX (live-safety, verified via in-proc e2e): `mapObjs` only spawned **5 gens**
  because the pick loop re-evaluated `Math.min(6, cands.length)` while `cands` shrank
  (once 5 candidates remained the limit collapsed to 5) → the 6-gen power switch was
  IMPOSSIBLE. Fixed by computing `want = Math.min(6, cands.length)` once; all maps now
  spawn 6 gens. e2e confirms the full win path: 6 gens → switch flip → 10s gate open →
  escape.
- BUGFIX (server CRASH): `escapeSurvivor` dereferenced `p.stats.esc` but **bots have no
  `stats`** → `TypeError: Cannot read properties of undefined (reading 'esc')` crashed
  a live match whenever a bot escaped (bots fill matches, so this hit often). Added
  `b.stats = {...}` in `giveBotBase` and a defensive `if (p.stats)` guard in
  `escapeSurvivor`. Verified via e2e (escape no longer crashes, status=escaped).
- BUGFIX (client render — "never see player body"): `ifMenu()`, `updatePrompt()`, the
  heartbeat interval, and `ensurePlayer`'s attach check all compared `matchState` to
  `'match'`, but the server sets match state to `'running'` (never `'match'`). So
  `ifMenu` always returned early → NO player body meshes were ever built/rendered.
  Fixed all in-match guards to use `matchState === 'hub'` / `!== 'hub'` (canonical
  states: `'hub' | 'running' | 'done'`). Verified with new `test/render-test.js`
  (headless: matchStart + real-shaped state frames → playerMeshes.size===2; was 0).
- BUGFIX (solid perimeter walls — "walls break open"): arena `±44` boundary was
  visual-only (no server collision), so players walked straight through the map
  edges. `wallBlocked` now enforces a solid perimeter that only lets you out through
  an **OPEN** gate gap; interior vault walls unchanged. Verified via e2e (closed gate
  blocks, open gate passes) + full escape path still works.

### IN PROGRESS / DONE SIGNALS
- Add matchmaking priority so a 2nd+ human can join a live bot match? (Currently
  only single human per match — decide: allow humans to join mid-match to feel alive,
  or keep 1 human/match for reliability. Prefer reliability in next pass, but log the
  decision here.)

----------------------------------------------------------------------------
## NEXT UP (do these in order, then append fresh ideas below)
1. [DONE] Survivor gameplay depth — item system (Medkit/Flashlight/Key/Toolbox +
   Hatch escape) implemented & pushed; do a live sanity check of pickup/use + fix
   anything the live game surfaces.
   [DONE] Exit system rework — power switch (6 gens) → powered gates → 10s gate open +
   vault walls killers can't follow.
2. Anti-boredom pacing — killer "bloodlust" ramps chase speed the longer a single
   chase goes; survivors get a short "sprint burst" with a cooldown so chases feel
   like DBD, not a stat check.
3. Cosmetic progression — track a simple account level (xp) locally (localStorage) +
   server kill/escape counter, unlock outfit colors at level thresholds. Gives the
   "lasts long" hook: a reason to come back and grind.
4. Variety — more maps (The Morgue), rotating "events" (Fog Frenzy = 2x speed,
   Blood Harvest = more hooks spawn) on a timer for novelty.

## FRESH IDEAS (backlog to append after the above)
- Survivor perk picker at login (2 perks each match, drawn from a small pool).
- Killer ability bar: special attack (Ravager=charge lunge, Brute=ground slam stun,
  Whisper=phase blink, Umbra=teleport to a shadow) on cooldown — makes killer fun.
- Kill feedback: killer gets a "satisfaction" combo counter; hit-stop/vignette.
- Bot difficulty calibration so wins aren't free but casuals still escape sometimes.
- A classic mode where 2+ humans can be in one match (the 1-human limit now is
  reliability-first; revisit once items/abilities are stable).
- Sound: killer-special stingers, heartbeat intensity by distance, chase music.
- Anti-cheat already there; add a per-match kill/death summary screen.
- Accessibility: rebindable keys, FOV slider, brightness/gamma.

- FEATURE (bot fills departed real players): when a real player disconnects mid-match,
  `onClose` now removes them from the match roster (match.players / match.survivors / as
  killer) and `fillReplacementBot(match, role, avoid)` spawns a same-role AI bot so the
  match stays populated (live-server only, IS_LIVE gated). Spawns on a safe spot >=18 units
  from the reference point and off vault walls; killer replacement reassigns match.killer.
  Coverage: `test/fill-test.js` (survivor + killer backfill into roster/global players).
  per-match hook counter (`p.hooks`, reset each match, exposed as `hooks` in match state
  and shown in survivor HUD). Hooks 1-2 RELEASE the survivor: they stand up (status='injured'),
  reset bleed/revive timers, and are dropped at a random safe spot far from the killer
  (`match.releaseSpots`, picked from positions >=28 units from killer, off vault walls).
  The 3rd hook sets `match.tripleHook` → `checkMatchEnd` ends the game IMMEDIATELY as an
  INSTANT KILLER WIN (all survivors lose), even if others are still alive or mid-escape.
  Killer HUD hint updated. Coverage: `test/hook3-test.js` (module-level, in shared vm scope).
  (`0.25*delta`) to the latest 20Hz server position, so fast movers (killer ~12 u/s,
  lunge 1.7x) visibly stepped/snapped. Added two-sample interpolation: on each fresh
  state frame the previous position is snapshotted into `prevPos`, and `animate()`
  draws each mesh between prev and current using render-time alpha (`(now-lastServerT)/45`),
  giving smooth glide independent of the 20Hz tick.
- TUNE (too-easy downing): killer-bot swing now requires much closer range (1.9 + sk*0.4 vs 2.7 + sk*0.6) and a tighter facing cone (1.3 - sk*0.5 vs 1.15 - sk*0.75); doAttack cooldown 250ms -> 900ms so a killer can't chain-down a walking survivor. Core downing mechanic preserved but far less frequent.
- FEATURE (username + password ACCOUNTS): anonymous entry removed. Clients now
  `register` (create account: name 2-16, password 4-64) or `login` (existing
  account). Passwords are salted (16-byte random salt) + SHA-256 hashed, stored
  in server/data/accounts.json (keyed by lowercased name, never plaintext).
  Both paths route through `setupPlayer()` which keeps the ban checks and admin
  key hook. Login form gained a password field + "REGISTER / LOG IN" toggle
  (public/index.html). Coverage: `test/smoke.js` registers 3 fresh accounts per
  run and uses `login` mode for reconnects/rejoins.
- FEATURE (AUTO-START MATCHMAKING): online real players in the hub (not yet in a
  match) are auto-placed into ONE match once 2+ are present — no manual queue
  button needed. Group uses REAL players only (cap 11 = 1 killer + survivors); NO
  initial queue bots. Bots exist solely as on-the-fly replacements when a real
  player leaves a live match (fillReplacementBot) — so enter the game and 2+
  real players will fight automatically. The old single-human-first-match
  bot-fill path (spawnBotsToFill inside the matchmaker) was removed from the
  auto tick to satisfy "no initial bots". Coverage: `test/smoke.js` auto-match
  assertions (all 3 online placed into the SAME match M1 with killer+survivor
  roles).
