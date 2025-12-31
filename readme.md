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
- Create `config.json`, `.env`, `users.json`, and `blacklist.json` files
- Add required values to `config.json` and `.env`
- Add users in the `users.json` file

4. Start the bot
```bash
node index.js
```

## Usage

- `/servers` - Opens a menu for the user to navigate through their owned servers.
- `/service` - Opens a menu that shows which nodes, nests, and eggs are available.

- `/info` - Retrieves general bot/panel information.
- `/help` - Displays available commands.
- `/set-client-key` - Sets client API key (required to run most commands).

## License

[MIT](https://choosealicense.com/licenses/mit/)