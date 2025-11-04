# PteroBot

A Discord bot integration for the Pterodactyl/Pyrodactyl Panel.

## Description

A simple discord bot that allows adminsistrators and users to manage their servers from within Discord. Made to extend functionality currently unavailable natively within the panel.

## Features

- Server status monitoring
- Start/Stop/Restart servers
- View server resources
- Send console commands
- Manage users and permissions

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
- Create `config.json`*, `keys.json`*, `users.json`*, and `blacklist.json` files
- Add required information to `config.json`
- Add Pterodactyl API key and Discord bot token to `keys.json`
- Add users in the `users.json` file (requires the administrator be added manually, further users can be added by the administrator via /add-user (not available yet!))

4. Start the bot
```bash
node index.js
```

## Configuration

Example `config.json`:
```json
{
    "developer_mode": false,
    "java_overhead_mb": 2048,
    "administrator_discord_id": "{discord_id}",
    "prod_client_id": "{discord_bot_client_id}",
    "prod_guild_id": "{discord_server_id}",
    "dev_client_id": "{dev_env}",
    "dev_guild_id": "{dev_env}"
}
```

## Usage

- `/gen-server` - Generate a new server
- `/get-eggs` - Get available eggs on the node
- `/get-nests` - Get available nests on the node
- `/get-nodes` - Get availabe nodes to deploy onto
- `/get-owned-servers` - Get servers that are owned by the user executing the command
- `/suspend-server` - Suspends a server (must be owned by the user executing the command)
- `/unsuspend-server` - Unsuspends a server (must be owned by the user executing the command)

## Contributing

Pull requests are welcome. For major changes, please open an issue first.

## License

[MIT](https://choosealicense.com/licenses/mit/)