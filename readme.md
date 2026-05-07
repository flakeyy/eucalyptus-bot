# PteroBot

[![CI Tests - main](https://github.com/flakeyy/pterobot/actions/workflows/nodejs-tests.yml/badge.svg?branch=main)](https://github.com/flakeyy/pterobot/actions/workflows/nodejs-tests.yml)
[![CI Tests - dev](https://github.com/flakeyy/pterobot/actions/workflows/nodejs-tests.yml/badge.svg?branch=dev)](https://github.com/flakeyy/pterobot/actions/workflows/nodejs-tests.yml)

A Discord bot integration for the Pterodactyl/Pyrodactyl Panel.

## Description

A simple discord bot that allows administrators and users to manage their servers from within Discord. Made to extend functionality currently unavailable natively within the panel.

This bot is made to work with [Pyrodactyl](https://github.com/pyrohost/pyrodactyl) + [Elytra](https://github.com/pyrohost/elytra) primarily, although it should work fine with [Pterodactyl](https://github.com/pterodactyl/panel) + [Wings](https://github.com/pterodactyl/wings) instances.

## Features

- Create and manage servers interactively
- Install CurseForge modpacks onto Minecraft servers
- View available eggs, nests, and nodes
- View and edit server properties
- Suspend, unsuspend, and delete servers
- Admin tools for managing bot users and their servers

## Installation

1. Clone the repository
```bash
git clone https://github.com/flakeyy/pterobot.git
```

2. Install dependencies
```bash
npm install
```

3. Configuration
- Copy `config.json.sample` → `config.json` and fill in the values
- Create a `.env` file with the required environment variables (see below)

4. Start the bot
```bash
node index.js
```

The bot creates a `pterobot.db` SQLite database on first run.

### Environment variables (`.env`)

| Variable | Description |
|---|---|
| `PROD_DISCORD_TOKEN` | Discord bot token (production) |
| `DEV_DISCORD_TOKEN` | Discord bot token (dev environment) |
| `PANEL_API_KEY` | Application API key from the panel |
| `ENCRYPTION_KEY` | 64-char hex key for AES-256-GCM encryption of stored client API keys. Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_DISCORD_ID` | Discord User ID for the Panel/Bot administrator |
| `PROD_CLIENT_ID` | Discord User ID for the Discord Bot executing the commands (prod) |
| `PROD_GUILD_ID` | Discord Guild ID for the primary Discord guild the bot will exist in (prod) |
| `DEV_CLIENT_ID` | Discord User ID for the Discord Bot executing the commands (dev, not needed) |
| `DEV_GUILD_ID` | Discord Guild ID for the primary Discord guild the bot will exist in (dev, not needed) |
| `PANEL_URL` | Full URL of your Pterodactyl/Pyrodactyl panel |
| `UPTIME_URL` | *(optional)* Uptime Kuma base URL |
| `UPTIME_SLUG` | *(optional)* Uptime Kuma status page slug |
| `CURSEFORGE_API_KEY` | *(required for /install-modpack command)* API key for the [Curseforge API](https://console.curseforge.com/?#/api-keys)

### config.json fields

| Field | Description |
|---|---|
| `debug` | Enable verbose API logging |
| `minecraft_nest_id` | Nest ID used for Minecraft server creation |
| `default_overhead_mb` | Default memory overhead added to new servers |
| `java_overhead_mb` | Additional overhead for Java-based servers |
| `modpack_eggs` | Egg IDs for each modloader (`forge`, `fabric`, `neoforge`, `quilt`) |
| `mc_version_variable` | Panel egg variable name for the Minecraft version (e.g. `MC_VERSION`) |
| `java_images` | Docker image map keyed by Java version (8, 11, 17, 21) |
| `minecraft_java_map` | Map of Minecraft version prefixes to required Java version |
| `mod_whitelist` | Array of CurseForge mod IDs that are always installed, even if detected as client-only |
| `mod_blacklist` | Array of CurseForge mod IDs that are always skipped during manifest installs |

## First-run setup

When the database has no users, the bot prints a one-time bootstrap token to the console on startup:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NO USERS FOUND — FIRST RUN SETUP
Bootstrap token: <token>
Run /init in Discord with this token to create the first admin account.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

In Discord, run:
```
/init token:<token> panel_username:<your panel username> panel_id:<your numeric panel user ID>
```

This creates your account with Administrator and Immunity permissions. The `/init` command is disabled permanently once any user exists. Use `/admin user create` to add additional users afterward.

> **Fallback:** if needed, you can insert a user directly into `pterobot.db` using any SQLite client. Set `permissions` to `196608` (Administrator + Immunity) for the first admin.

## Permissions

`permissions` is a bitwise integer stored per user:

| Flag | Value | Description |
|---|---|---|
| `GET_SERVICE_INFORMATION` | 1 | View eggs, nests, nodes |
| `SET_CLIENT_KEY` | 2 | Set own client API key |
| `READ_SERVERS` | 4 | View owned servers |
| `EDIT_SERVER_PROPERTIES` | 8 | Edit server settings |
| `CREATE_SERVER` | 16 | Create new servers |
| `ADMINISTRATOR` | 65536 | Bypass all permission checks |

`maximumAllowedMemory` is in MB; `-1` means unlimited.

### Immunity

The user created via `/init` is granted a hidden Immunity flag (value `131072`) in addition to Administrator. Immunity is not visible or toggleable in the admin UI. Any user holding it cannot have their profile edited, permissions changed, or account deleted by other administrators through the bot. It cannot be assigned to other users.

## Usage

- `/servers` — Interactive server management menu (view, edit, suspend/unsuspend/delete).
- `/gen-server` — Interactive menu to create a new server.
- `/install-modpack` — Install a CurseForge modpack onto one of your Minecraft servers.
- `/service` — View service information including nodes, nests, and eggs.
- `/info` — Retrieves current service information.
- `/help` — Displays available commands.
- `/set-client-key` — Sets your client API key (required for most commands).
- `/admin user view` — View a user's bot profile.
- `/admin user create` — Add a Discord user to the bot database.
- `/admin user edit` — Interactively edit a user's bot profile.
- `/admin user delete` — Remove a user from the bot database.
- `/admin servers` — Manage a user's servers as admin (bypasses memory limits).

## install-modpack

`/install-modpack` walks through an interactive multi-step flow to fully replace a Minecraft server's contents with a CurseForge modpack.

### Flow

1. **Select server** — lists your Minecraft servers (non-Minecraft servers are excluded).
2. **Enter CurseForge Project ID** — found in the *About Project* section on the modpack's CurseForge page.
3. **Select version** — up to 10 recent versions are shown, latest first. Server packs are interleaved above their matching client version and pre-selected where available.
4. **Confirm** — two confirmation steps warn that all existing server files will be permanently deleted.

### Installation steps

Once confirmed, the bot performs these steps automatically:

1. Stops the server and waits for it to go offline.
2. Deletes all existing server files.
3. Switches the server egg to match the modpack's loader (`forge`, `fabric`, `neoforge`, or `quilt`), sets `MC_VERSION`, and selects the correct Java Docker image.
4. Reinstalls the server and waits for the reinstall to finish.
5. Downloads and installs the modpack (see below).

### Server pack vs. client pack

- **Server pack** (preferred) — downloaded and extracted directly to the server root.
- **Client pack / manifest** — used when no server pack is available, or if you choose to override. The bot extracts the `overrides/` directory to the server root, then resolves and downloads each required mod individually. A warning is shown on completion reminding you to check for client-only mod compatibility.

### ServerStarter support

Some CurseForge server packs use the [ServerStarter](https://github.com/BloodyMods/ServerStarter) spec instead of bundling the modpack directly. These zips contain a `server-setup-config.yaml` that points to the actual modpack download.

When the bot detects this file, it:

1. Reads `install.modpackUrl` from the config and downloads the real modpack from that URL.
2. Reads `install.formatSpecific.ignoreProject` — a list of CurseForge project IDs to exclude. These are treated identically to `mod_blacklist` entries (skipped from both mod downloads and override extraction).
3. Continues with the normal manifest or direct-extract flow on the downloaded modpack.

All other ServerStarter fields (Java args, RAM, loader installer, etc.) are ignored — those are handled at the server level, not by the bot.

### Manifest mod resolution

When installing from a manifest, the bot:

- Resolves download URLs for all required mods via the CurseForge batch API.
- Cross-references every mod against Modrinth by SHA1 hash to detect client-only mods. A slug-based fallback is used for mods whose CurseForge and Modrinth builds have different hashes.
- Skips client-only mods automatically — they are not installed on the server.
- For mods with no CurseForge download URL (distribution disabled), attempts a Modrinth fallback URL via SHA1 match.
- Mods that cannot be downloaded from either source are listed at the end with links to their CurseForge pages.
- Downloads mods in parallel batches, bundles each batch into a zip, and uploads it to `/mods/`.

### Mod whitelist / blacklist

You can override the automatic client-only detection per mod using CurseForge mod IDs in `config.json`:

- **`mod_whitelist`** — mods that are always installed, even if detected as client-only.
- **`mod_blacklist`** — mods that are always skipped, regardless of Modrinth detection.

Both lists apply during manifest installs. `ignoreProject` entries from a ServerStarter config are merged with `mod_blacklist` at install time and have the same effect.

## License

[ISC](https://choosealicense.com/licenses/isc/)
