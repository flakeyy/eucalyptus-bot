# Modpack client-only detection accuracy report

Generated: 2026-08-08T12:02:45.846Z

## Method

- **Decision under test:** production Layer 1 precedence table (`decideModInstall`: blocklist → allowlist/server-overrides → learned verdicts → provider → explicit metadata → curated client list → provider-unsupported → Layer 2 crash scan → install) plus the dependency-rescue/propagation fixpoints — same pipeline as `/install-modpack`.
- **Ground truth:** Modrinth **project** `server_side` looked up by JAR hash (slug fallback), with hand-triaged golden overrides from `scripts/eval_overrides.json` applied on top.
- **Provider input** (what the installer sees): mrpack `env.server` or CurseForge→Modrinth project side — may disagree with project labels on lazy packs.
- **Unlabeled mods** (no Modrinth project side and no override) are excluded from accuracy math but listed for coverage.

## Overall (all labeled mods across packs)

| Variant | N | Accuracy | Precision | Recall | Spec | F1 | TP | TN | FP | FN |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| JAR-only | 3980 | 92.5% | 79.3% | 74.1% | 96.2% | 76.6% | 486 | 3197 | 127 | 170 |
| JAR + provider | 3980 | 99.3% | 96.6% | 99.4% | 99.3% | 98.0% | 652 | 3301 | 23 | 4 |

## Per-pack summary

| Pack | Loader | MC | Jars | Labeled | Skip | Install | Comb Acc | Comb FP | Comb FN | Rescues | Strong overrides |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| All the Mods 9 (ATM9) | forge | 1.20.1 | 433 | 324 | 34 | 399 | 100.0% | 0 | 0 | 0 | 0 |
| Create: Above and Beyond | forge | 1.16.5 | 136 | 63 | 10 | 126 | 100.0% | 0 | 0 | 0 | 0 |
| RLCraft | forge | 1.12.2 | 178 | 87 | 27 | 151 | 97.7% | 1 | 1 | 0 | 0 |
| Better Minecraft [Fabric] | fabric | 1.20.1 | 333 | 312 | 83 | 250 | 99.4% | 2 | 0 | 0 | 0 |
| FTB Skies | forge | 1.19.2 | 327 | 228 | 34 | 293 | 100.0% | 0 | 0 | 0 | 0 |
| GregTech: New Horizons (GTNH) | forge | 1.7.10 | 44 | 25 | 5 | 39 | 100.0% | 0 | 0 | 0 | 0 |
| Prominence II RPG | fabric | 1.20.1 | 442 | 402 | 98 | 344 | 99.5% | 2 | 0 | 0 | 0 |
| Enigmatica 9 | forge | 1.19.2 | 232 | 163 | 20 | 212 | 100.0% | 0 | 0 | 0 | 0 |
| Valhelsia 6 | forge | 1.20.1 | 279 | 225 | 45 | 234 | 99.1% | 2 | 0 | 0 | 0 |
| SevTech: Ages | forge | 1.12.2 | 259 | 120 | 25 | 234 | 98.3% | 1 | 1 | 0 | 0 |
| Cobblemon Official | fabric | 1.21.1 | 74 | 73 | 45 | 29 | 97.3% | 2 | 0 | 0 | 0 |
| Vault Hunters 3rd Edition | forge | 1.18.2 | 168 | 116 | 21 | 147 | 98.3% | 2 | 0 | 0 | 0 |
| Pixelmon Reforged | neoforge | 1.21.1 | 13 | 12 | 2 | 11 | 100.0% | 0 | 0 | 0 | 0 |
| Divine Journey 2 | forge | 1.12.2 | 223 | 103 | 19 | 204 | 98.1% | 1 | 1 | 0 | 0 |
| Simply Optimized | fabric | 1.21.11 | 17 | 17 | 6 | 11 | 100.0% | 0 | 0 | 0 | 0 |
| Stoneblock 3 | forge | 1.18.2 | 224 | 148 | 20 | 204 | 100.0% | 0 | 0 | 0 | 0 |
| Medieval Minecraft | forge | 1.20.1 | 456 | 369 | 74 | 382 | 100.0% | 0 | 0 | 0 | 0 |
| Nomifactory CEu | forge | 1.12.2 | 148 | 80 | 18 | 130 | 97.5% | 1 | 1 | 0 | 0 |
| FTB Academy | forge | 1.12.2 | 116 | 47 | 25 | 91 | 97.9% | 1 | 0 | 0 | 0 |
| MC Eternal | forge | 1.12.2 | 344 | 139 | 27 | 317 | 99.3% | 1 | 0 | 0 | 0 |
| Create: Astral | fabric | 1.18.2 | 202 | 157 | 47 | 155 | 99.4% | 1 | 0 | 0 | 0 |
| Craft to Exile 2 | forge | 1.20.1 | 396 | 306 | 65 | 331 | 99.0% | 3 | 0 | 0 | 0 |
| Feed The Beast Infinity Evolved | forge | 1.7.10 | 135 | 33 | 4 | 131 | 100.0% | 0 | 0 | 0 | 0 |
| Integrated Minecraft | forge | 1.20.1 | 312 | 247 | 56 | 256 | 98.8% | 3 | 0 | 0 | 0 |
| DawnCraft | forge | 1.18.1 | 298 | 184 | 50 | 248 | 100.0% | 0 | 0 | 0 | 0 |

## What needs work

### False positives (skipped despite Modrinth server-ok): 23
These are the riskiest: we drop a mod the provider says belongs on the server.

By JAR signal:
- `unknown/null/no-signal`: 17
- `client/explicit/mod-annotation-clientSideOnly`: 6

Examples:
- **[rlcraft]** ResourceLoader-MC1.12.1-1.5.3.jar (`resourceloader`) — client/explicit/mod-annotation-clientSideOnly, provider=null
- **[better-mc-fabric]** xaerominimap-fabric-1.20.1-25.3.5.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional
- **[better-mc-fabric]** xaeroworldmap-fabric-1.20.1-1.40.6.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[prominence-ii]** xaerominimap-fabric-1.20.1-25.3.10.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional
- **[prominence-ii]** xaeroworldmap-fabric-1.20.1-1.40.11.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[valhelsia-6]** Xaeros_Minimap_25.2.0_Forge_1.20.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional
- **[valhelsia-6]** XaerosWorldMap_1.39.4_Forge_1.20.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[sevtech]** ResourceLoader-MC1.12.1-1.5.3.jar (`resourceloader`) — client/explicit/mod-annotation-clientSideOnly, provider=null
- **[cobblemon]** xaerominimap-fabric-1.21.1-25.3.5.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional
- **[cobblemon]** xaeroworldmap-fabric-1.21.1-1.40.6.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[vault-hunters-3]** Xaeros_Minimap_25.2.10_Forge_1.18.2.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional
- **[vault-hunters-3]** XaerosWorldMap_1.39.12_Forge_1.18.2.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[divine-journey-2]** ResourceLoader-MC1.12.1-1.5.3.jar (`resourceloader`) — client/explicit/mod-annotation-clientSideOnly, provider=null
- **[nomi-ceu]** ResourceLoader-MC1.12.1-1.5.3.jar (`resourceloader`) — client/explicit/mod-annotation-clientSideOnly, provider=null
- **[ftb-academy]** ResourceLoader-MC1.12.1-1.5.3.jar (`resourceloader`) — client/explicit/mod-annotation-clientSideOnly, provider=null
- **[mc-eternal]** ResourceLoader-MC1.12.1-1.5.3.jar (`resourceloader`) — client/explicit/mod-annotation-clientSideOnly, provider=null
- **[create-astral]** automobility-0.3+1.18.2.jar (`automobility`) — unknown/null/no-signal, provider=null
- **[craft-to-exile-2]** xaeroworldmap-forge-1.20.1-1.44.2.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[craft-to-exile-2]** xaerominimap-forge-1.20.1-26.4.2.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional
- **[craft-to-exile-2]** fancymenu_forge_3.9.9_MC_1.20.1.jar (`fancymenu`) — unknown/null/no-signal, provider=optional
- **[integrated-mc]** XaerosWorldMap_1.39.12_Forge_1.20.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[integrated-mc]** Xaeros_Minimap_25.2.10_Forge_1.20.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional
- **[integrated-mc]** forgery-3.6.5+1.20.jar (`fabrication`) — unknown/null/no-signal, provider=null

### False negatives (installed despite Modrinth unsupported): 4
Client-only mods that may still land on the server (crash risk).

By JAR signal:
- `unknown/null/no-metadata`: 4

Examples:
- **[rlcraft]** carrotslib-mc1.12.2-1.0.0b1.jar (`carrots`) — unknown/null/no-metadata, provider=null
- **[sevtech]** CarryOn MC1.12.2 v1.12.3.jar (`carryon`) — unknown/null/no-metadata, provider=required
- **[divine-journey-2]** extendedcrafting-nomifactory-edition-1.7.0.7.jar (`extendedcrafting`) — unknown/null/no-metadata, provider=null
- **[nomi-ceu]** extendedcrafting-nomifactory-edition-1.7.0.7.jar (`extendedcrafting`) — unknown/null/no-metadata, provider=null

### Dependency rescues (rescuable skip → install, required by installed mods): 0


## Per-slot skip sources (all packs)

- `slot6:curated-client-list`: 288
- `slot7:provider-unsupported`: 187
- `slot5:env-client`: 183
- `slot5:mod-annotation-clientSideOnly`: 106
- `slot1:blocklist`: 58
- `slot5:clientSideOnly`: 16
- `slot8:crash-risk`: 11
- `slot5:cross-loader-env`: 11

## Recommended follow-ups

1. Triage new combined FPs — confirm whether the golden label or a curated-list/Layer-2 hit is wrong; fix the list, not a heuristic.
2. Triage new combined FNs — remaining installs of true client mods are mopped up by the boot-verify loop; only chase ones that crash servers.
3. Keep `scripts/eval_overrides.json` in sync when Modrinth labels are confirmed wrong; seed `data/server_side_overrides.json` for server-needed mislabels.
