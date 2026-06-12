// Shared constants used across command files. Previously these were redefined
// independently in admin.js, server_menu.js, server_gen.js, install_modpack.js,
// and service_information.js.

// Accent colors for ContainerBuilder responses.
const COLORS = {
  PRIMARY: 0x6b34eb,
  ADMIN: 0xeb4034,
  SUCCESS: 0x00aa00,
  DISABLED: 0x808080
};

// Pterodactyl/HTTP status codes the bot checks for.
const HTTP_STATUS_CODES = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  UNAUTHORIZED: 401,
  CONFLICT: 409
};

// Byte → display-unit divisors.
const UNIT_CONVERSIONS = {
  BYTES_TO_MB: 1_000_000,
  BYTES_TO_GB: 1_000_000_000
};

// How long an interactive component collector stays live while idle (5 minutes).
const COLLECTOR_IDLE_TIMEOUT = 300_000;

// WebSocket-driven console/stats refresh throttling.
const WS_THROTTLE_MS = 3000;
const CONSOLE_MAX_LINES = 20;
const CONSOLE_PREVIEW_LINES = 5;

module.exports = {
  COLORS,
  HTTP_STATUS_CODES,
  UNIT_CONVERSIONS,
  COLLECTOR_IDLE_TIMEOUT,
  WS_THROTTLE_MS,
  CONSOLE_MAX_LINES,
  CONSOLE_PREVIEW_LINES
};
