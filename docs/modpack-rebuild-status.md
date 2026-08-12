# Modpack installer rebuild — progress notes

Branch: `rebuild/modpack-installer`  
Plan: `.claude/plans/currently-have-a-setup-delegated-gosling.md`

## Phase gates

| Phase | Status | Notes |
|---|---|---|
| 0 Baseline | done | Combined accuracy **99.322%** (`docs/modpack-corpus-phase0-baseline.md`) |
| 1 Reporter seam | done | `utility/modpack/job.js` + `reporters.js` |
| 2 Delete Layer 2 | done | `client_signals.js`; crash_risk + 86MB cache deleted. Phase 2 accuracy **99.221%** (−0.10pp, within 1%) |
| 3 Server-pack-first | done | Providers prefer `serverPackFileId`; Wings `pullServerFile` fast path with local-extract fallback |
| 4 Boot verify rebuild | done | `boot_verify.js` ~590 lines; `boot_remediations/` capped at 5; X11/JEID deleted |
| 5 Triage | done | `utility/modpack/triage/` behind provider interface; wired into unattributable boot path |
| 6 Search UX | done | Autocomplete in `index.js`; `/install-modpack pack:` + optional `server:`; single confirm; channel handoff |
| 7 Docs | partial | readme + config/.env samples updated; SUMMARY.md / live smoke matrix still pending |

## Realignment pass (2026-08-08)

Phases 1–5 of `.claude/plans/robust-cuddling-snail.md`: four correctness fixes
(nested-archive bypass, triage token budget, `done()` handoff, handoff clock),
operational bounds on triage and both autocompletes, per-pack tables moved into
capped `data/*.json`, and the two missing verification tiers built. Live
`config.json` migrated. See `SUMMARY.md` for current state and
`docs/modpack-blockers.md` for accepted structural deviations.

| Phase | Status |
|---|---|
| 7 Docs | done — readme, CLAUDE.md, SUMMARY.md, blockers doc |
| Tier 1 `scripts/modpack_preflight.js` | done — offline plan dump |
| Tier 2 `scripts/modpack_smoke.js` | built (replaces `live_modpack_matrix.js`), **not yet run** |

## Remaining before “feature done”

1. `npm install @anthropic-ai/sdk` when enabling live triage (optional dep — code soft-requires it).
2. Set `ANTHROPIC_API_KEY` in `.env` and confirm a real verdict comes back (the no-key path is already a verified no-op).
3. **Tier 2 smoke against a live panel** — `node scripts/modpack_smoke.js --server=<id>`. Required before deploying.
4. `node deploy.js` then Discord smoke: `/install-modpack pack:` autocomplete → install on scratch server.

## Expected unsupported after X11/JEID cut

- `cottage-witch` (X11 natives removed)
- `meatballcraft` (JEID auto-install removed)
