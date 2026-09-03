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
- ITEM SYSTEM (server+client): Medkit/Toolbox/Flashlight/Key pickups spawn at the
  edges (4+nplayers, ≤8), Hatch + Key escape, medkit heals, toolbox 1.9x repair,
  flashlight stuns killer 2.5s, sfx + prompts + held-item HUD. matchView verified live
  (types present); full pickup->use flow pending live sanity check.

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
