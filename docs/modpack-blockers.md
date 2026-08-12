# Modpack installer — accepted deviations

The rebuild plan carried a stop rule: when a structural target is missed, record
it here as a decision rather than leaving a reader to find a silently-missed
number and go looking for a regression that does not exist.

Every item below was **reviewed and accepted**, not overlooked. Each states the
target, the current number, and why the deviation stands.

Last updated: 2026-08-09, on `rebuild/modpack-installer` after the realignment
pass (Phases 1–6), the cofh_core incident (§4), and a green Tier 2 matrix.
Line counts are `wc -l` at that commit.

---

## 1. Three modules over the 600-line tripwire

| File | Lines | Target |
|---|---:|---:|
| `utility/crash_attribution.js` | 824 | 600 |
| `utility/boot_verify.js` | 629 | 600 |
| `utility/modpack_install.js` | 673 | 600 |

**Decision: not split.** The tripwire exists to catch modules that have quietly
become grab bags. These three have not; each is one cohesive state machine whose
length comes from the number of distinct real-world failure shapes it handles,
not from unrelated concerns sharing a file.

The concrete risk is the test asset. `tests/boot_verify.test.js` drives the loop
through a FakeWS console stream — the most valuable tests in the feature, because
they are the only place the crash → attribute → quarantine → retry cycle runs
end to end. Splitting `boot_verify.js` or `crash_attribution.js` means moving the
seams those tests bind to, and a refactor that rewrites its own safety net is a
refactor with no safety net.

`modpack_install.js` (673) is worth calling out separately: it was **already at
604 before this realignment pass** and was not recorded in the original plan —
so it is a genuinely missed target being written down for the first time here,
not a new regression. It has since grown further: exporting the archive
classification helpers for the preflight (§5), and restructuring the archive
install into decide → rescue → commit to fix the cofh_core incident (§4). The
rescue extraction is net-neutral in logic — it moved an inline block out of
`installFilePlan` into a shared function — but the two-pass archive rewrite is
genuinely new code paying for a real correctness gap.

**Revisit when:** a behavioural change requires touching one of these files
anyway, or the FakeWS tests are refactored for another reason. Splitting is
cheap to do alongside work already in the blast radius and expensive as its own
change.

**Not in scope:** `commands/ptero/server_menu.js` (858) and
`commands/ptero/server_gen.js` (603) are also over the tripwire but predate this
feature entirely and share none of its code.

---

## 2. `boot_remediations/` is 976 lines against a ~340 estimate

| File | Lines |
|---|---:|
| `utility/boot_remediations/egg.js` | 413 |
| `utility/boot_remediations/jars.js` | 348 |
| `utility/boot_remediations/index.js` | 210 |
| `utility/boot_remediations/_helpers.js` | 5 |
| **total** | **976** |

**Decision: accepted.** The estimate was wrong, not the implementation. What the
plan actually cared about is enforced and holds:

- the registry is **capped at 5 remediations**, with a test that fails on a sixth;
- **no individual file exceeds 600 lines** (largest is 413);
- each remediation is a named, independently testable unit.

A 976-line directory of four focused files is not the failure mode the estimate
was guarding against — an uncapped registry growing one entry per unlucky pack
is, and that cannot happen.

---

## 3. Four `attempt--` refund sites instead of an explicit budget

```
utility/boot_verify.js:433   attempt--;
utility/boot_verify.js:479   if (rem.refundAttempt) attempt--;
utility/boot_verify.js:513   attempt--;
utility/boot_verify.js:579   attempt--;
```

**Decision: kept.** Decrementing the loop counter so a remediation attempt does
not consume a user-visible retry is a genuinely awkward pattern — the counter
means two things at once, and a future reader will have to think about it.

Replacing it with an explicit budget object is the right shape, and it is also a
rewrite of the loop's central control flow, verified by exactly the FakeWS tests
described in §1. The realignment's whole premise is that the verification ladder
was missing; rebuilding the control flow *before* Tier 2 has ever run against a
live panel inverts that. The refund sites are documented and bounded by
`total_budget_ms` regardless, so a bug here costs time, not correctness.

**Revisit when:** Tier 2 (`scripts/modpack_smoke.js`) has a green baseline to
regress against. At that point the change is verifiable rather than hopeful.

---

## 4. The cofh_core incident (2026-08-08) — three bugs, two fixed at the source

The first live Tier 2 run installed ATM9 and the server would not boot. Reported
symptom: "cofh_core was quarantined, it's a dep for many mods." The cause was not
boot-verify quarantine at all — it was install-time classification:

```
[install-modpack] skip archive mod (client-only, client-signals): cofh_core-1.20.1-11.0.2.56.jar
```

Five Thermal mods that declare `cofh_core` as a required dependency installed
fine; the dependency itself did not. Three separate defects, all pre-existing:

**(a) Separator mismatch in the protected list.** CoFH Core is `cofhcore` on 1.12
and `cofh_core` on 1.16+. `data/protected_mods.json` carried only the old
spelling, so `isProtectedLearnedMod` returned false and slot 8 was free to skip
it. Same class of miss for `thermal_foundation` / `thermal_expansion`.
**Fixed:** matching is now separator-insensitive on both sides, plus an exact
comparison against the jar's leading name segment.

**(b) `forge` matched every Forge jar.** The filename token loop skipped ids
under 5 characters, but `forge` is exactly 5 — so every `*-forge-*.jar`
(journeymap, MouseTweaks, Controlling, sodium…) was treated as protected. Most of
a Forge pack was silently immune to quarantine *and* to slot-8 skips.
**Fixed:** loader/runtime cores carry `"filenameMatch": false` and are modId-only.

Fixing (b) initially made things look worse — ATM9's skips went 21 → 26 — because
the bug had been accidentally masking (c).

**(c) No dependency rescue on the archive path.** `installFilePlan` runs a rescue
fixpoint: a rescuably-skipped mod that an installed mod hard-requires gets
reinstated. `installArchiveBuffer` decided every jar in one streaming pass and
committed immediately, so on an archive install *a single classification mistake
was terminal*. This is why nothing recovered `cofh_core` despite nine installed
dependents naming it.
**Fixed:** the rescue and propagation passes were extracted into a shared
`applyDependencyRescue()` and the archive path restructured into
decide → rescue → commit. `scripts/modpack_preflight.js` calls the same function,
so Tier 1 cannot report a skip the real install would rescue.

**Harness fix.** The corpus sweep had already run ATM9 and called it clean —
because nothing checked dependency satisfaction, and the summary line
("397 install / 21 skip") looks healthy right up until the server won't start.
Tier 1 now cross-checks every installed mod's `requiredDeps` against what will
actually be on disk and **fails the pack** when a hard dependency is one this
install would skip, distinguishing that (our bug) from a dep absent from the pack
entirely (the pack's own metadata). Per the stop rule: the failure could not be
reproduced in the harness, so the harness was the thing to fix.

### Result on ATM9, with no per-pack overrides

| | before | after |
|---|---:|---:|
| installed | 397 (no cofh_core) | **393 + rescue** |
| `cofh_core` | skipped → server dead | installs (protected) |
| `supermartijn642corelib` | skipped | dep-rescued |

### What is deliberately *not* fixed

Nine slot-8 (`client-signals`) false positives remain on ATM9: `Quark`, `Zeta`,
`Draconic-Evolution`, `tombstone`, `ae2wtlib`, `ExtendedAE`, `deeperdarker`,
`fusion`, `konkrete`. Dependency rescue cannot reach them — they are leaf content
mods, not libraries, so nothing declares a hard dependency on them.

This is the accuracy of the `client_signals` bytecode heuristic
("server-applied client mixin config"), a separate problem from this incident.
It is left alone rather than patched per-pack: the mods are **parked in
`mods-disabled/`, not deleted** (recoverable via
`scripts/restore_parked_mods.js`), they do not block boot, and boot-verify is the
designed backstop. Adding them to `data/server_side_overrides.json` was tried and
reverted — per-pack curation is exactly the surface growth §3 of the rebuild set
out to stop.

---

## 5. Deliberate coupling: `modpack_install.js` exports its internals

`decideWithClientSignals`, `normalizeArchiveEntryPath`, `shouldSkipArchiveEntry`,
and `isArchiveModsJar` are exported solely for `scripts/modpack_preflight.js`.

This widens a module's public surface for a script's benefit, which is normally
worth resisting. It is accepted because the alternative is worse: a preflight
that reimplements classification is a preflight that can pass while the installer
fails. The harness has to run the same code the install runs, or a green Tier 1
means nothing — which is the precise failure the realignment is correcting.

---

## Verification ladder status

| Tier | What it is | Status |
|---|---|---|
| 0 | `npm test` + `npx eslint .` | green — 493 tests, 26 suites |
| 1 | `scripts/modpack_preflight.js` — offline plan dump, no panel | **12/12 corpus packs clean** |
| 2 | `scripts/modpack_smoke.js` — live panel, 6 packs, one per axis | **6/6 install + boot, 15m30s total** |

Tier 2 is required before deploying. It is the only tier that can prove the
Phase 1 fixes hold against a real Wings daemon rather than a mock — and on
2026-08-09 it did: all six axes installed and booted on the **first** attempt
with zero quarantines, on server `9cf843d1`.

| Pack | Axis | Mods on disk | Duration |
|---|---|---:|---:|
| All the Mods 9 | CF server pack · Forge · **nested root** | 393 | 5m 1s |
| All the Mods 10 | CF server pack · NeoForge | 441 | 4m 45s |
| FTB Academy | CF · legacy 1.12 Forge (Java 8) | 91 | 1m 7s |
| Enigmatica 9 | CF server pack → manifest plan | 212 | 2m 44s |
| Fabulously Optimized | CF manifest-only · Fabric | 15 | 32s |
| Simply Optimized | Modrinth `.mrpack` | 11 | 29s |

Median 2m 44s, slowest 5m 1s, **15m 30s for the whole matrix**. The plan's
"about 15 minutes" was a claim about a *single* install; measured, a whole
six-axis matrix fits in that budget and the slowest single pack is ~5 minutes.

Aggregate time by stage: boot-verify 5m33s, place 5m17s, reinstall 3m00s,
download 21s, everything else under 15s combined. Placement and boot dominate;
download is negligible because the Wings pull path and chunked upload both keep
bytes off the bot.

### Tier 1 immediately justified itself

The first pack of the first corpus sweep — **All the Mods 9** — reported:

```
  pack type              server pack
  strategy               archive
  nested root            "Server-Files-1.1.1/"  ⚠ flatten required — Wings pull skipped
  mods                   397 install / 21 skip of 418
```

ATM9's server pack wraps everything in a single folder. It met every condition
for the Wings pull fast path (server pack, CDN URL, no client pack), so before
the Phase 1.1 fix it would have decompressed in place to
`/Server-Files-1.1.1/mods/`, found `/mods` empty, indexed **0 jars**, and
reported *Installation Complete* on a server with none of its 397 mods.

This is exactly the claim the realignment plan made — that the missing tier
would have caught this class of bug offline — demonstrated on the first pack it
was pointed at. ATM9 is now the permanent nested-root case in the Tier 2 set.
