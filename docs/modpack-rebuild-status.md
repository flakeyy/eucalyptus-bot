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

## Remaining before “feature done”

1. `npm install @anthropic-ai/sdk` when enabling live triage (optional dep — code soft-requires it).
2. `node deploy.js` then Discord smoke: `/install-modpack pack:` autocomplete → install on scratch server.
3. Tier 2 smoke: `scripts/modpack_smoke.js` (rewrite from `live_modpack_matrix.js` still pending).
4. Update `SUMMARY.md` against new results.

## Expected unsupported after X11/JEID cut

- `cottage-witch` (X11 natives removed)
- `meatballcraft` (JEID auto-install removed)
