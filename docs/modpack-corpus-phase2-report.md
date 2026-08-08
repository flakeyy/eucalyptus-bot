# Modpack client-only detection accuracy report

Generated: 2026-08-08T12:11:35.573Z

## Method

- **Decision under test:** production Layer 1 precedence table (`decideModInstall`: blocklist → allowlist/server-overrides → learned verdicts → provider → explicit metadata → curated client list → provider-unsupported → client_signals → install) plus the dependency-rescue/propagation fixpoints — same pipeline as `/install-modpack`.
- **Ground truth:** Modrinth **project** `server_side` looked up by JAR hash (slug fallback), with hand-triaged golden overrides from `scripts/eval_overrides.json` applied on top.
- **Provider input** (what the installer sees): mrpack `env.server` or CurseForge→Modrinth project side — may disagree with project labels on lazy packs.
- **Unlabeled mods** (no Modrinth project side and no override) are excluded from accuracy math but listed for coverage.

## Overall (all labeled mods across packs)

| Variant | N | Accuracy | Precision | Recall | Spec | F1 | TP | TN | FP | FN |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| JAR-only | 3980 | 87.7% | 60.1% | 74.8% | 90.2% | 66.7% | 491 | 2998 | 326 | 165 |
| JAR + provider | 3980 | 99.2% | 96.2% | 99.2% | 99.2% | 97.7% | 651 | 3298 | 26 | 5 |

## Per-pack summary

| Pack | Loader | MC | Jars | Labeled | Skip | Install | Comb Acc | Comb FP | Comb FN | Rescues | Strong overrides |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| All the Mods 9 (ATM9) | forge | 1.20.1 | 433 | 324 | 41 | 392 | 100.0% | 0 | 0 | 0 | 0 |
| Create: Above and Beyond | forge | 1.16.5 | 136 | 63 | 16 | 120 | 100.0% | 0 | 0 | 0 | 0 |
| RLCraft | forge | 1.12.2 | 178 | 87 | 31 | 147 | 97.7% | 1 | 1 | 0 | 0 |
| Better Minecraft [Fabric] | fabric | 1.20.1 | 333 | 312 | 83 | 250 | 99.4% | 2 | 0 | 0 | 0 |
| FTB Skies | forge | 1.19.2 | 327 | 228 | 38 | 289 | 100.0% | 0 | 0 | 0 | 0 |
| GregTech: New Horizons (GTNH) | forge | 1.7.10 | 44 | 25 | 8 | 36 | 100.0% | 0 | 0 | 0 | 0 |
| Prominence II RPG | fabric | 1.20.1 | 442 | 402 | 98 | 344 | 99.5% | 2 | 0 | 0 | 0 |
| Enigmatica 9 | forge | 1.19.2 | 232 | 163 | 25 | 207 | 100.0% | 0 | 0 | 0 | 0 |
| Valhelsia 6 | forge | 1.20.1 | 279 | 225 | 47 | 232 | 97.8% | 4 | 1 | 0 | 0 |
| SevTech: Ages | forge | 1.12.2 | 259 | 120 | 34 | 225 | 97.5% | 2 | 1 | 0 | 0 |
| Cobblemon Official | fabric | 1.21.1 | 74 | 73 | 45 | 29 | 97.3% | 2 | 0 | 0 | 0 |
| Vault Hunters 3rd Edition | forge | 1.18.2 | 168 | 116 | 24 | 144 | 97.4% | 3 | 0 | 0 | 0 |
| Pixelmon Reforged | neoforge | 1.21.1 | 13 | 12 | 2 | 11 | 100.0% | 0 | 0 | 0 | 0 |
| Divine Journey 2 | forge | 1.12.2 | 223 | 103 | 25 | 198 | 98.1% | 1 | 1 | 0 | 0 |
| Simply Optimized | fabric | 1.21.11 | 17 | 17 | 6 | 11 | 100.0% | 0 | 0 | 0 | 0 |
| Stoneblock 3 | forge | 1.18.2 | 224 | 148 | 27 | 197 | 100.0% | 0 | 0 | 0 | 0 |
| Medieval Minecraft | forge | 1.20.1 | 456 | 369 | 77 | 379 | 100.0% | 0 | 0 | 0 | 0 |
| Nomifactory CEu | forge | 1.12.2 | 148 | 80 | 25 | 123 | 97.5% | 1 | 1 | 1 | 0 |
| FTB Academy | forge | 1.12.2 | 116 | 47 | 26 | 90 | 95.7% | 2 | 0 | 0 | 0 |
| MC Eternal | forge | 1.12.2 | 344 | 139 | 33 | 311 | 99.3% | 1 | 0 | 1 | 0 |
| Create: Astral | fabric | 1.18.2 | 202 | 157 | 43 | 159 | 100.0% | 0 | 0 | 0 | 0 |
| Craft to Exile 2 | forge | 1.20.1 | 396 | 306 | 65 | 331 | 99.0% | 3 | 0 | 0 | 0 |
| Feed The Beast Infinity Evolved | forge | 1.7.10 | 135 | 33 | 8 | 127 | 100.0% | 0 | 0 | 0 | 0 |
| Integrated Minecraft | forge | 1.20.1 | 312 | 247 | 61 | 251 | 99.2% | 2 | 0 | 0 | 0 |
| DawnCraft | forge | 1.18.1 | 298 | 184 | 53 | 245 | 100.0% | 0 | 0 | 0 | 0 |

## What needs work

### False positives (skipped despite Modrinth server-ok): 26
These are the riskiest: we drop a mod the provider says belongs on the server.

By JAR signal:
- `unknown/null/no-signal`: 18
- `client/explicit/mod-annotation-clientSideOnly`: 6
- `unknown/null/no-metadata`: 2

Examples:
- **[rlcraft]** ResourceLoader-MC1.12.1-1.5.3.jar (`resourceloader`) — client/explicit/mod-annotation-clientSideOnly, provider=null
- **[better-mc-fabric]** xaerominimap-fabric-1.20.1-25.3.5.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional
- **[better-mc-fabric]** xaeroworldmap-fabric-1.20.1-1.40.6.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[prominence-ii]** xaerominimap-fabric-1.20.1-25.3.10.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional
- **[prominence-ii]** xaeroworldmap-fabric-1.20.1-1.40.11.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[valhelsia-6]** StorageDrawers-1.20.1-12.9.13.jar (`storagedrawers`) — unknown/null/no-signal, provider=null
- **[valhelsia-6]** Xaeros_Minimap_25.2.0_Forge_1.20.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional
- **[valhelsia-6]** XaerosWorldMap_1.39.4_Forge_1.20.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[valhelsia-6]** fairylights-7.0.0-1.20.1.jar (`fairylights`) — unknown/null/no-signal, provider=null
- **[sevtech]** StorageDrawers-1.12.2-5.4.2.jar (`storagedrawers`) — unknown/null/no-metadata, provider=null
- **[sevtech]** ResourceLoader-MC1.12.1-1.5.3.jar (`resourceloader`) — client/explicit/mod-annotation-clientSideOnly, provider=null
- **[cobblemon]** xaerominimap-fabric-1.21.1-25.3.5.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional
- **[cobblemon]** xaeroworldmap-fabric-1.21.1-1.40.6.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[vault-hunters-3]** Xaeros_Minimap_25.2.10_Forge_1.18.2.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional
- **[vault-hunters-3]** XaerosWorldMap_1.39.12_Forge_1.18.2.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[vault-hunters-3]** fairylights-5.0.0-1.18.2.jar (`fairylights`) — unknown/null/no-signal, provider=null
- **[divine-journey-2]** ResourceLoader-MC1.12.1-1.5.3.jar (`resourceloader`) — client/explicit/mod-annotation-clientSideOnly, provider=null
- **[nomi-ceu]** ResourceLoader-MC1.12.1-1.5.3.jar (`resourceloader`) — client/explicit/mod-annotation-clientSideOnly, provider=null
- **[ftb-academy]** ResourceLoader-MC1.12.1-1.5.3.jar (`resourceloader`) — client/explicit/mod-annotation-clientSideOnly, provider=null
- **[ftb-academy]** StorageDrawers-1.12.2-5.4.0.jar (`storagedrawers`) — unknown/null/no-metadata, provider=null
- **[mc-eternal]** ResourceLoader-MC1.12.1-1.5.3.jar (`resourceloader`) — client/explicit/mod-annotation-clientSideOnly, provider=null
- **[craft-to-exile-2]** xaeroworldmap-forge-1.20.1-1.44.2.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[craft-to-exile-2]** xaerominimap-forge-1.20.1-26.4.2.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional
- **[craft-to-exile-2]** fancymenu_forge_3.9.9_MC_1.20.1.jar (`fancymenu`) — unknown/null/no-signal, provider=optional
- **[integrated-mc]** XaerosWorldMap_1.39.12_Forge_1.20.jar (`xaeroworldmap`) — unknown/null/no-signal, provider=optional
- **[integrated-mc]** Xaeros_Minimap_25.2.10_Forge_1.20.jar (`xaerominimap`) — unknown/null/no-signal, provider=optional

### False negatives (installed despite Modrinth unsupported): 5
Client-only mods that may still land on the server (crash risk).

By JAR signal:
- `unknown/null/no-metadata`: 4
- `unknown/null/no-signal`: 1

Examples:
- **[rlcraft]** carrotslib-mc1.12.2-1.0.0b1.jar (`carrots`) — unknown/null/no-metadata, provider=null
- **[valhelsia-6]** betterjukebox-1.20-1.3.jar (`betterjukebox`) — unknown/null/no-signal, provider=null
- **[sevtech]** CarryOn MC1.12.2 v1.12.3.jar (`carryon`) — unknown/null/no-metadata, provider=required
- **[divine-journey-2]** extendedcrafting-nomifactory-edition-1.7.0.7.jar (`extendedcrafting`) — unknown/null/no-metadata, provider=null
- **[nomi-ceu]** extendedcrafting-nomifactory-edition-1.7.0.7.jar (`extendedcrafting`) — unknown/null/no-metadata, provider=null

### Dependency rescues (rescuable skip → install, required by installed mods): 2

- **[nomi-ceu]** StorageDrawers-1.12.2-5.5.3.jar
- **[mc-eternal]** StorageDrawers-1.12.2-5.4.2.jar

## Per-slot skip sources (all packs)

- `slot6:curated-client-list`: 288
- `slot7:provider-unsupported`: 188
- `slot5:env-client`: 183
- `slot5:mod-annotation-clientSideOnly`: 106
- `slot8:client-signals`: 91
- `slot1:blocklist`: 58
- `slot5:clientSideOnly`: 16
- `slot5:cross-loader-env`: 11

## Recommended follow-ups

1. Triage new combined FPs — confirm whether the golden label or a curated-list/Layer-2 hit is wrong; fix the list, not a heuristic.
2. Triage new combined FNs — remaining installs of true client mods are mopped up by the boot-verify loop; only chase ones that crash servers.
3. Keep `scripts/eval_overrides.json` in sync when Modrinth labels are confirmed wrong; seed `data/server_side_overrides.json` for server-needed mislabels.
