# Modpack installer — current state

**Branch:** `rebuild/modpack-installer`
**Updated:** 2026-08-08 (realignment pass, Phases 1–5)

This replaces the previous SUMMARY.md, which reported the 50-pack live matrix run
on `dev` in July 2026. That document is no longer accurate: this branch deleted
the X11 and JEID remediations it credited, replaced Layer 2 with `client_signals`,
and rewrote selection to be server-pack-first. Its results describe code that no
longer exists.

## What `/install-modpack` does

Takes a CurseForge or Modrinth pack from an empty Pterodactyl server to a booted
dedicated server:

1. **Select** — autocomplete search across both providers, ranked locally by name
   relevance rather than downloads (`utility/modpack/search.js`). One option per
   version, preferring the author's server pack when one is published.
2. **Resolve** — download, unwrap ServerStarter wrappers, and choose a strategy:
   manifest plan (Modrinth `.mrpack`, CF manifest packs) or archive extract
   (CF server packs, loose zips).
3. **Place** — nothing destructive happens until the server confirms *offline*.
   Then wipe → change egg (pinning loader build and Java image from the pack) →
   reinstall → place files.
4. **Verify** — start the server and empirically confirm it boots, attributing
   crashes to specific jars, quarantining them, and retrying
   (`utility/boot_verify.js` + `utility/boot_remediations/`).

Everything after step 1 runs through `runModpackJob` against a **reporter**, not
a Discord interaction — so the same path runs under Discord, Jest, and the live
smoke harness.

## Verification ladder

| Tier | Command | Needs | Status |
|---|---|---|---|
| 0 | `npm test` && `npx eslint .` | nothing | **green** — 493 tests, 26 suites |
| 1 | `node scripts/modpack_preflight.js --corpus` | provider API keys | **12/12 corpus packs clean** |
| 2 | `node scripts/modpack_smoke.js --server=<id>` | live panel, ~16m | **6/6 install + boot** |

Tier 1's first sweep found that **All the Mods 9**'s server pack wraps everything
in `Server-Files-1.1.1/`. That pack met every condition for the Wings pull fast
path, so before this pass it would have installed 0 of its 397 mods and reported
success. Details in [`docs/modpack-blockers.md`](docs/modpack-blockers.md).

**Tier 1** prints the plan the installer *would* execute — strategy, nested
archive root, mod counts, per-jar skips with precedence slot and reason,
unavailable files — while touching no server. It is the loop to work in; a full
pack preflights in a few seconds.

**Tier 2** installs and boots six packs, one per axis (CF server pack Forge and
NeoForge, CF manifest-only Fabric, Modrinth `.mrpack`, legacy 1.12 Forge,
ServerStarter-wrapped), asserts install *and* boot, and records per-stage wall
clock. **Required before deploying.**

The ladder exists because the bugs fixed in this pass were all invisible to Tier 0
and would have been obvious one tier up. Its stop rule: *a fix that cannot be
reproduced in Tier 1 or Tier 2 first does not get written* — if a failure cannot
be reproduced in the harness, the harness is the thing to fix.

## What this pass changed

**Correctness**

- A nested archive root (`/PackName/mods/…`, the common CF server-pack layout)
  no longer takes the Wings pull fast path, which extracts as-is and would leave
  `/mods` empty while reporting success. An empty `/mods` after a successful
  decompress is now a fallback trigger rather than a result.
- Triage `max_tokens` raised to 8192 with thinking disabled, and a null
  `parsed_output` now logs its `stop_reason` instead of no-oping silently.
  **Measured caveat:** the plan predicted 1024 would routinely truncate; against
  the live API it does not. At the configured `effort: medium` a verdict is
  ~100–140 output tokens even with a 29K-character prompt and adaptive thinking
  left on. The larger budget is cheap headroom (`max_tokens` is a cap, not a
  reservation) and matters only if `effort` is raised — at `effort: max` the same
  prompt produced 584 output tokens. Treat this as hardening, not a bug fix.
- `done()` now takes the channel handoff path, so a job finishing past the
  15-minute token window reports its result to a live message instead of a dead
  token that swallows the failure.
- The handoff clock starts at the original interaction, not at confirm — a user
  can spend minutes in the wizard before the install begins.

**Operational**

- Triage requests bounded (60s timeout, 1 retry) instead of the SDK default of
  10 minutes × 2 retries, which could consume the entire boot budget.
- Autocomplete fan-out cut: 3-character minimum, slug resolution capped, and an
  in-flight map so repeated prefixes share one upstream round trip.
- Server autocomplete cached per user and bounded against Discord's 3s deadline.
- Version lists no longer emit both the server and client pack for every version.

**Structure**

- The two per-pack tables that grew outside the capped registry now live in
  `data/protected_mods.json` and `data/search_aliases.json`, each with a
  per-entry rationale and a test enforcing its cap.

## Known deviations

Recorded with rationale and current numbers in
**[`docs/modpack-blockers.md`](docs/modpack-blockers.md)** — three modules over
the 600-line tripwire, `boot_remediations/` at 976 lines against a ~340 estimate,
and four `attempt--` refund sites. All reviewed and accepted; none is a
regression to chase.

## Running it

```bash
# Tier 1 — offline, no panel
node scripts/modpack_preflight.js --pack="all the mods 10"
node scripts/modpack_preflight.js --pack=cf:336409 --version=2792369
node scripts/modpack_preflight.js --corpus --limit=10

# Tier 2 — live panel (rotate the client key afterwards)
export LIVE_CLIENT_API_KEY="…"
node scripts/modpack_smoke.js --list
node scripts/modpack_smoke.js --server=<server-id>

# Search ranking only
node scripts/modpack_search.js "better mc"
node scripts/eval_modpack_search.js
```

Optional: `npm install @anthropic-ai/sdk` and set `ANTHROPIC_API_KEY` to enable
last-resort crash triage. Without either, triage is a clean no-op.
