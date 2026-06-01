// Admin-command-specific data tables and tuning knobs.

// Power-action polling: after sending start/stop/restart, poll the server's
// resource state until it reaches the expected state (or we give up).
const POWER_ACTION_CONFIG = {
  MAX_ATTEMPTS: 30,
  POLL_INTERVAL: 1000
};

// Servers per page in `/admin servers view`.
const SERVERS_PER_PAGE = 10;

// Maps select-menu option values to DB column names and display labels for
// `/admin user edit`.
const EDITABLE_FIELDS = [
  { value: "panel_username",         label: "Panel Username",            description: "The user's Pterodactyl panel username",          numeric: false },
  { value: "panel_id",               label: "Panel ID",                  description: "The user's numeric Pterodactyl user ID",          numeric: true  },
  { value: "maximum_allowed_memory", label: "Max Memory (MB, -1 = ∞)",   description: "Maximum total memory this user can allocate",     numeric: true  },
  { value: "permissions",            label: "Permissions",               description: "Toggle individual permissions granted to this user", numeric: false },
  { value: "panel_api_key",          label: "Panel API Key",             description: "The user's stored client API key",                numeric: false }
];

// Permissions exposed as toggle buttons in the edit UI (IMMUNITY is intentionally
// excluded — it is assigned only via /init).
const PERM_LABELS = [
  { key: "GET_SERVICE_INFORMATION", label: "Get Service Info" },
  { key: "SET_CLIENT_KEY",          label: "Set Client Key" },
  { key: "READ_SERVERS",            label: "Read Servers" },
  { key: "EDIT_SERVER_PROPERTIES",  label: "Edit Server Props" },
  { key: "CREATE_SERVER",           label: "Create Server" },
  { key: "ADMINISTRATOR",           label: "Administrator" }
];

module.exports = {
  POWER_ACTION_CONFIG,
  SERVERS_PER_PAGE,
  EDITABLE_FIELDS,
  PERM_LABELS
};
