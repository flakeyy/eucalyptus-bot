# PteroBot

[![CI Tests - main](https://github.com/flakeyy/pterobot/actions/workflows/nodejs-tests.yml/badge.svg?branch=main)](https://github.com/flakeyy/pterobot/actions/workflows/nodejs-tests.yml)
[![CI Tests - dev](https://github.com/flakeyy/pterobot/actions/workflows/nodejs-tests.yml/badge.svg?branch=dev)](https://github.com/flakeyy/pterobot/actions/workflows/nodejs-tests.yml)

A Discord bot integration for the Pterodactyl/Pyrodactyl Panel.

## Description

A simple discord bot that allows adminsistrators and users to manage their servers from within Discord. Made to extend functionality currently unavailable natively within the panel.

## Features

- create new servers
- view available eggs, nests, nodes
- view/edit servers
- suspend/unsuspend/delete servers

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
- Copy `users.json.sample` → `users.json` and add your users — the bot will migrate this into the database on first boot

4. Start the bot
```bash
node index.js
```

The bot creates a `pterobot.db` SQLite database on first run. If `users.json` and `blacklist.json` exist, their data is automatically imported and the files are no longer needed afterward.

### Environment variables (`.env`)

| Variable | Description |
|---|---|
| `PROD_DISCORD_TOKEN` | Discord bot token (production) |
| `DEV_DISCORD_TOKEN` | Discord bot token (dev mode) |
| `PANEL_URL` | Full URL of your Pterodactyl/Pyrodactyl panel |
| `PANEL_API_KEY` | Application API key from the panel |
| `ENCRYPTION_KEY` | 64-char hex key for AES-256-GCM encryption of stored client API keys. Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `UPTIME_URL` | *(optional)* Uptime Kuma base URL |
| `UPTIME_SLUG` | *(optional)* Uptime Kuma status page slug |

### config.json fields

| Field | Description |
|---|---|
| `debug` | Enable verbose API logging |
| `minecraft_nest_id` | Nest ID used for server creation |
| `default_overhead_mb` | Default memory overhead added to new servers |
| `java_overhead_mb` | Additional overhead for Java-based servers |

### users.json format (for initial import)

```json
{
  "users": [
    {
      "discordId": "123123123123123",
      "panelUsername": "user1",
      "panelId": 1,
      "maximumAllowedMemory": -1,
      "permissions": 65536
    }
  ]
}
```

`maximumAllowedMemory` is in MB; `-1` means unlimited. `permissions` is a bitwise integer:

| Flag | Value | Description |
|---|---|---|
| `GET_SERVICE_INFORMATION` | 1 | View eggs, nests, nodes |
| `SET_CLIENT_KEY` | 2 | Set own client API key |
| `READ_SERVERS` | 4 | View owned servers |
| `EDIT_SERVER_PROPERTIES` | 8 | Edit server settings |
| `CREATE_SERVER` | 16 | Create new servers |
| `ADMINISTRATOR` | 65536 | Bypass all permission checks |

## Usage

- `/servers` - Opens a menu for the user to navigate through their owned servers.
- `/service` - Opens a menu that shows which nodes, nests, and eggs are available.

- `/info` - Retrieves general bot/panel information.
- `/help` - Displays available commands.
- `/set-client-key` - Sets client API key (required to run most commands).

## License

[MIT](https://choosealicense.com/licenses/mit/)
