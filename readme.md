# eucalyptus/bot

[![CI Tests - main](https://github.com/flakeyy/eucalyptus-bot/actions/workflows/nodejs-tests.yml/badge.svg?branch=main)](https://github.com/flakeyy/eucalyptus-bot/actions/workflows/nodejs-tests.yml)
[![CI Tests - dev](https://github.com/flakeyy/eucalyptus-bot/actions/workflows/nodejs-tests.yml/badge.svg?branch=dev)](https://github.com/flakeyy/eucalyptus-bot/actions/workflows/nodejs-tests.yml)

A Discord bot integration for the Pyrodactyl/Pterodactyl Panel.

## Description

A simple discord bot that allows administrators and users to manage their servers from within Discord. Made to extend functionality currently unavailable natively within the panel.

This bot is made to work with [Pyrodactyl](https://github.com/pyrohost-oss/pyrodactyl) + [Elytra](https://github.com/pyrodactyl-oss/elytra) primarily, although it should work fine with [Pterodactyl](https://github.com/pterodactyl/panel) + [Wings](https://github.com/pterodactyl/wings) instances.

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
git clone https://github.com/flakeyy/eucalyptus-bot.git
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
| `DISCORD_TOKEN` | Discord bot token |
| `PANEL_API_KEY` | Application API key from the panel |
| `ENCRYPTION_KEY` | 64-char hex key for AES-256-GCM encryption of stored client API keys. Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_DISCORD_ID` | Discord User ID for the Panel/Bot administrator |
| `CLIENT_ID` | Discord application/client ID for the bot |
| `GUILD_ID` | *(optional)* If set, `deploy.js` registers slash commands to this guild only (instant updates). Leave blank to deploy globally. |
| `PANEL_URL` | Full URL of your Pterodactyl/Pyrodactyl panel |
| `UPTIME_PROVIDER` | *(optional)* `kuma` (default) |
| `UPTIME_URL` | *(optional)* Base URL of the status host |
| `UPTIME_SLUG` | *(optional)* Status page slug — `/status/<slug>` for Kuma |
| `UPTIME_PANEL_MONITOR_ID` | *(Kuma only)* Monitor ID for the panel |
| `UPTIME_NODE_MONITOR_ID` | *(Kuma only)* Monitor ID for the node |
| `UPTIME_API_KEY` | *(custom provider only)* Bearer token for the custom status API |
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
| `mod_id_blocklist` | Array of mod IDs as declared inside the mod's own metadata (e.g. `"drippyloadingscreen"`), not CurseForge project IDs. Mods matching an entry are always skipped during manifest installs. |

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


## License

[ISC](https://choosealicense.com/licenses/isc/)
