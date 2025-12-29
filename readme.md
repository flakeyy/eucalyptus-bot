# PteroBot

[![CI Tests - main](https://github.com/flakeyy/pterobot/actions/workflows/nodejs-tests.yml/badge.svg?branch=main)](https://github.com/flakeyy/pterobot/actions/workflows/nodejs-tests.yml)
[![CI Tests - dev](https://github.com/flakeyy/pterobot/actions/workflows/nodejs-tests.yml/badge.svg?branch=dev)](https://github.com/flakeyy/pterobot/actions/workflows/nodejs-tests.yml)

A Discord bot integration for the Pterodactyl/Pyrodactyl Panel.

## Description

A simple discord bot that allows adminsistrators and users to manage their servers from within Discord. Made to extend functionality currently unavailable natively within the panel.

## Features

- create new servers
- view available eggs, nests, nodes
- view owned servers (per user)
- suspend/unsuspend servers
- more to come..

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
- Create `config.json`, `.env`, `users.json`, and `blacklist.json` files
- Add required values to `config.json` and `.env`
- Add users in the `users.json` file (requires the administrator be added manually, further users can be added by the administrator via /add-user (not available yet!))

4. Start the bot
```bash
node index.js
```

## Usage

- `/gen-server` - Generate a new server
- `/edit-server` - Edit server variables
- `/get-servers` - Get user-owned servers
- `/get-server-details` - Get the details of a specific server
- `/suspend-server` - Suspends a server
- `/unsuspend-server` - Unsuspends a server

- `/get-eggs` - Get available eggs on the node
- `/get-nests` - Get available nests on the node
- `/get-nodes` - Get availabe nodes to deploy onto

- `/info` - Retrieves current service information
- `/set-client-key` - Sets client API key (required to run almost any commands)

## Contributing

Pull requests are welcome. For major changes, please open an issue first.

## License

[MIT](https://choosealicense.com/licenses/mit/)
