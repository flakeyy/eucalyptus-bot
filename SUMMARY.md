# Live Modpack Matrix — Final Summary

**Date:** 2026-07-19 / 2026-07-20  
**Branch:** `dev`  
**Goal:** Auto-install and boot-verify all **50** curated Minecraft modpacks on Pterodactyl server `f20fed63` (`https://srv.flakey.tech/`).

## Result

| Metric | Count |
|--------|------:|
| Packs | 50 |
| Install OK | **50** |
| Boot OK | **50** |
| Install / boot failures | **0** |

Evidence: `docs/live-modpack-matrix-NOTES.md`, `docs/live-modpack-matrix-results.json`.  
Last successful `mc-eternal` retest (~4m 37s): EnderIO family quarantined, false-crash resume, then `Done`.

> Rotate the panel client API key used for live runs if it was exposed in chat/logs.

## What this campaign proved

`/install-modpack` + `verifyServerBoot` can take a curated CurseForge/Modrinth pack from empty server → installed mods → running dedicated server, including hard packs that need:

- Client-jar filtering and crash attribution
- Quarantine + dependency expansion
- Headless / X11 workarounds on yolk images
- Registry-overflow rescue (JEID)
- Ignoring Wings console history and false “crashed state” markers

## Environment

```text
PANEL_URL=https://srv.flakey.tech/
Server: f20fed63
Auth: LIVE_CLIENT_API_KEY (or panel client key in users DB) from .env
Also: CURSEFORGE_API_KEY for CDN downloads
```

Retest one pack:

```powershell
cd C:\Users\Dylan\Desktop\Things\cs\js\pterobot
$env:PANEL_URL = "https://srv.flakey.tech/"
node scripts/live_modpack_matrix.js --server=f20fed63 --only=<pack-key>
```

Full matrix: omit `--only`. Notes/results are rewritten under `docs/`.

## Hard packs and how they were fixed

| Pack | Failure mode | Fix |
|------|----------------|-----|
| **Archive / Wings 500s** (ATM9, RAD, RAD2, Create Perfect World, etc.) | Nested decompress / list 500s | Local extract + filter + chunked upload (`modpack_install` / HTTP path) |
| **CDN / null downloadUrl** (Enigmatica 9, …) | ForgeCDN auth / missing URLs | `x-api-key` on CDN; `synthesizeCurseForgeCdnUrl` |
| **Client jars on “server” packs** (DawnCraft, Meatball, …) | `ParticleManager` / client class missing | Curated client filter + `clientClassMissing` quarantine (no AE2 cascade) |
| **create-astral / ATM10** | KubeJS / MI / nested scripts | Protect MI; surgical kubejs neutralize; unix_args headless insert (don’t wipe) |
| **meatballcraft** | Forge registry ID overflow | Auto-download/install JustEnoughIDs (CurseForge 296289) |
| **cottage-witch** | AWT / missing X11 + GUI | Debian 11 X11 `.so`s in `/native`, inline `DISPLAY=` + `LD_LIBRARY_PATH`, append `nogui` to `unix_args.txt` |
| **mc-eternal** | EnderIO hard-fail; then Wings false crashes mid-Morph | EnderIO hard-fail + family quarantine; protect CraftTweaker; post-pull crash grace; ignore definite crash while loading without new report; **resume watch without kill** on stale report + loading |

GTNH was replaced in the matrix with **ATM6** (client-pack-only GTNH listing was not a viable dedicated target).

## Boot-verify design (what matters)

Core loop: `utility/boot_verify.js` + `utility/crash_attribution.js` + `utility/verdict_store.js`.

1. **Start + watch** websocket console for `Done (...)!` or hard crash markers.
2. **Attribute** crash report / console → jars → quarantine to `mods-disabled/` (+ dependents).
3. **Retry** until success, attempt budget, or unattributed stop.

Important behaviors added during this push:

- Prefer `*-server.txt` crash reports; ignore already-acted report names.
- Soft Forge noise (`has failed to load correctly`, etc.) does **not** end the watch; hard markers do.
- Wings “Detected server process in a crashed state” alone does not kill a still-running JVM.
- After Docker pull: grace window + don’t arm `javaBootSeen` from history burst.
- If outcome is “crash” but console shows Morph/recipe loading and only a **stale** crash report → **resume watch without restart** (this unlocked Eternal).
- Protect pack-critical mods from weak quarantine (CraftTweaker, Mekanism, MI, MineColonies, …).
- Cap weak stack-frame / mixin-only quarantines; don’t quarantine CraftTweaker via stack frames.
- MissingMods short ids (e.g. `art`) resolve via `byModId`, not filename heuristic alone.
- Egg startup: env/file/`nogui` patches — do **not** wrap multiline Forge eggs with `rm`/`export` shells.

## Key files touched

| Area | Paths |
|------|--------|
| Boot verify | `utility/boot_verify.js`, `tests/boot_verify.test.js` |
| Attribution | `utility/crash_attribution.js`, `tests/crash_attribution.test.js` |
| Learned verdicts | `utility/verdict_store.js` |
| Install / HTTP / CF | `utility/modpack_install.js`, `modpack_http.js`, `curseforge.js`, `mod_inspector.js` |
| Command / matrix | `commands/ptero/install_modpack.js`, `scripts/live_modpack_matrix.js` |
| Data | `data/client_side_mods.json`, `data/server_side_overrides.json` |
| Config sample | `config.json.sample` (`boot_verify.max_attempts` → 8) |
| Results | `docs/live-modpack-matrix-NOTES.md`, `docs/live-modpack-matrix-results.json` |

## Quarantine reality check

“Boot OK” means the dedicated process reached a verified running state after automatic remediation. Some packs quarantine broken or client-tied jars (e.g. Eternal drops EnderIO + dependents). That is intentional for **server bring-up**, not a claim that every upstream mod remains enabled.

## Suggested next steps

1. Commit the uncommitted matrix/boot-verify work on `dev` when ready (do not commit `.env` / live keys).
2. Rotate the live client API key used on `f20fed63`.
3. Optionally fold Eternal-style “resume watch on stale crash” into a short regression test with a FakeWS Morph flood.
4. Keep `HANDOFF.md` as historical mid-campaign notes; this file is the **final** scoreboard.

## Commands

```bash
npm test
npx eslint .
node scripts/live_modpack_matrix.js --server=f20fed63
```
