#!/usr/bin/env node
// Local dev harness for invoking bot commands without a live Discord connection.
//
// It loads commands exactly like index.js, builds a synthetic interaction, calls
// the command's execute(), and renders whatever the command would send back
// (content / embeds / components). Panel-backed commands hit the real panel via
// PANEL_URL / PANEL_API_KEY from your .env — point that at your dev environment.
//
// Interactive flows (select menus, buttons, modals) are driven by feeding the
// command's message-component collector synthetic component interactions, either
// scripted with --step or live with --interactive.
//
// Usage:
//   node scripts/dev-run.js --list
//   node scripts/dev-run.js help
//   node scripts/dev-run.js info
//   node scripts/dev-run.js set-client-key --api-key=ptlc_xxx
//   node scripts/dev-run.js admin --group=user --sub=add --user=123456789012345678
//
//   # Drive a collector (scripted): pick the "nodes" category, then nest id 1
//   node scripts/dev-run.js service --step category-selection=nodes --step nest-selection=1
//
//   # A step that opens a modal supplies its field values after '#':
//   node scripts/dev-run.js install-modpack \
//     --step server-select=abc123 \
//     --step "proceed-to-url#modpack-url-input=https://www.curseforge.com/.../files/123"
//
//   # Drive it by hand instead:
//   node scripts/dev-run.js service --interactive
//
// Flags:
//   --list                 list loaded commands and exit
//   --<name>=<value>       a slash-command option
//   --<name> <value>       same, space-separated
//   --<name>               boolean option set to true
//   --sub=<name>           subcommand (for grouped commands like /admin)
//   --group=<name>         subcommand group
//   --as=<discordId>       invoking user's Discord id (default: ADMIN_DISCORD_ID)
//   --as-name=<username>   invoking user's username (default: devtester)
//   --step <dsl>           a collector interaction (repeatable); see step DSL below
//   --script <file.json>   load steps from a JSON array (overrides --step)
//   --interactive          drive the collector live from stdin
//   --end-reason=<reason>  reason passed to the collector's end handler (default: idle)
//
// Step DSL:  customId[=value1,value2][#field1=val1;field2=val2]
//   • bare customId        → a button press
//   • =a,b                 → select-menu values
//   • #field=val;field=val → text-input values for a modal opened by that step
//
// getUser options accept "id" or "id:username", e.g. --user=123:bob
require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { Collection } = require("discord.js");
const msgLog = require("../utility/logger.js");
const { initDatabase } = require("../utility/database.js");
const { applicationApiCall } = require("../utility/helper_functions.js");

// Internal flags that are not slash-command options.
const RESERVED = new Set([ "sub", "group", "as", "as-name", "list", "step", "script", "interactive", "end-reason" ]);

// Reason passed to collector "end" handlers once scripted steps are exhausted.
// Defaults to "idle" — the natural outcome of a user walking away, which is what
// most end handlers key off of to disable their components.
let END_REASON = "idle";

// Shared harness state, referenced by both the interaction and the collectors.
const state = {
  invokingUser: null,
  collectors: []
};

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  const set = (k, v) => {
    if (k in opts) opts[k] = Array.isArray(opts[k]) ? [ ...opts[k], v ] : [ opts[k], v ];
    else opts[k] = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        set(body.slice(0, eq), body.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        set(body, argv[++i]);
      } else {
        set(body, true); // boolean flag
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function loadCommands() {
  const commands = new Collection();
  const foldersPath = path.join(__dirname, "..", "commands");
  for (const folder of fs.readdirSync(foldersPath)) {
    const commandsPath = path.join(foldersPath, folder);
    if (!fs.statSync(commandsPath).isDirectory()) continue;
    for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith(".js"))) {
      const command = require(path.join(commandsPath, file));
      if ("data" in command && "execute" in command) {
        commands.set(command.data.name, command);
      }
    }
  }
  return commands;
}

// ── Rendering ────────────────────────────────────────────────────────────────
function toPlain(x) {
  return x && typeof x.toJSON === "function" ? x.toJSON() : x;
}

function describeComponent(c, indent = 0) {
  const pad = "  ".repeat(indent);
  const lines = [];
  const kids = () => (c.components || []).forEach(ch => lines.push(...describeComponent(ch, indent + 1)));
  switch (c.type) {
  case 17: // Container
    lines.push(`${pad}┌─ Container`);
    kids();
    break;
  case 1: // Action row
    lines.push(`${pad}• Row`);
    kids();
    break;
  case 10: // Text display
    (c.content || "").split("\n").forEach(l => lines.push(`${pad}${l}`));
    break;
  case 2: // Button
    lines.push(`${pad}[Button "${c.label || c.emoji?.name || ""}" → ${c.custom_id || c.url || ""}]`);
    break;
  case 3: // String select
    lines.push(`${pad}[Select "${c.placeholder || ""}" id=${c.custom_id}]`);
    (c.options || []).forEach(o => lines.push(`${pad}    - ${o.label} (${o.value})`));
    break;
  case 4: // Text input (inside modals)
    lines.push(`${pad}[TextInput "${c.label || ""}" id=${c.custom_id}]`);
    break;
  case 14: // Separator
    lines.push(`${pad}──────────`);
    break;
  default:
    lines.push(`${pad}[component type ${c.type}]`);
    kids();
  }
  return lines;
}

function describeEmbed(e, i) {
  const lines = [ `  Embed #${i + 1}:` ];
  if (e.title) lines.push(`    title: ${e.title}`);
  if (e.description) e.description.split("\n").forEach(l => lines.push(`    ${l}`));
  (e.fields || []).forEach(f => lines.push(`    ${f.name}: ${f.value}`));
  return lines;
}

function render(label, payload) {
  const out = [ `\n── ${label} ─────────────────────────────────────────────` ];
  if (typeof payload === "string") {
    out.push(payload);
  } else if (payload && typeof payload === "object") {
    if (payload.content) out.push(payload.content);
    (payload.embeds || []).map(toPlain).forEach((e, i) => out.push(...describeEmbed(e, i)));
    (payload.components || []).map(toPlain).forEach(c => out.push(...describeComponent(c)));
    if (payload.ephemeral || (payload.flags && String(payload.flags).includes("64"))) out.push("(ephemeral)");
  }
  console.log(out.join("\n"));
}

// ── Collectors ───────────────────────────────────────────────────────────────
// A real-enough collector: it stores the handlers the command registers so the
// driver can emit "collect"/"end" with synthetic component interactions.
function makeCollector(options = {}) {
  const handlers = {};
  let ended = false;
  const collector = {
    _filter: options.filter,
    _stopped: false,
    _stopReason: null,
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return collector; },
    once(ev, fn) { return collector.on(ev, fn); },
    stop(reason) { collector._stopped = true; collector._stopReason = reason || "stopped"; },
    resetTimer() {},
    async emitCollect(i) { for (const fn of handlers.collect || []) await fn(i); },
    async emitEnd(reason) {
      if (ended) return;
      ended = true;
      for (const fn of handlers.end || []) await fn(new Collection(), reason);
    }
  };
  return collector;
}

const fakeMessage = {
  createMessageComponentCollector(opts = {}) {
    const collector = makeCollector(opts);
    state.collectors.push(collector);
    console.log(`\n(collector attached${opts.filter ? " with user filter" : ""})`);
    return collector;
  },
  edit: async p => { render("MESSAGE EDIT", p); return fakeMessage; }
};

function renderModalFields(modalPlain, supplied) {
  for (const row of modalPlain.components || []) {
    for (const comp of row.components || []) {
      if (comp.type === 4) {
        const id = comp.custom_id;
        const val = supplied[id];
        console.log(`    field "${comp.label || id}" (${id}): ${val === undefined ? "<none supplied>" : JSON.stringify(val)}`);
      }
    }
  }
}

function makeModalSubmit(modalPlain, modalValues) {
  return {
    customId: modalPlain.custom_id,
    user: state.invokingUser,
    fields: {
      getTextInputValue: id => {
        if (modalValues[id] === undefined) {
          console.log(`  (no value supplied for modal field "${id}" — using "")`);
          return "";
        }
        return modalValues[id];
      }
    },
    deferUpdate: async () => {},
    update: async p => { render("MODAL UPDATE", p); return fakeMessage; },
    reply: async p => { render("MODAL REPLY", p); return fakeMessage; },
    editReply: async p => { render("MODAL EDIT REPLY", p); return fakeMessage; },
    followUp: async p => { render("MODAL FOLLOW UP", p); return fakeMessage; }
  };
}

function makeComponentInteraction(step) {
  const i = {
    customId: step.customId,
    values: step.values,
    user: state.invokingUser,
    client: { user: { id: "dev-bot", tag: "dev-bot#0000" } },
    _modal: null,
    deferUpdate: async () => {},
    update: async p => { render("UPDATE (component)", p); return fakeMessage; },
    reply: async p => { render("COMPONENT REPLY", p); return fakeMessage; },
    followUp: async p => { render("COMPONENT FOLLOW UP", p); return fakeMessage; },
    editReply: async p => { render("EDIT REPLY (component)", p); return fakeMessage; },
    fetchReply: async () => fakeMessage,
    showModal: async modal => {
      i._modal = toPlain(modal);
      console.log(`  (modal shown: ${i._modal.custom_id})`);
      renderModalFields(i._modal, step.modal);
    },
    awaitModalSubmit: async ({ filter } = {}) => {
      const submit = makeModalSubmit(i._modal || {}, step.modal);
      if (filter && !filter(submit)) throw new Error("modal filter rejected synthetic submission");
      return submit;
    }
  };
  return i;
}

function parseStep(str) {
  const modal = {};
  let rest = str;
  const hashIdx = rest.indexOf("#");
  if (hashIdx !== -1) {
    for (const pair of rest.slice(hashIdx + 1).split(";")) {
      const eq = pair.indexOf("=");
      if (eq !== -1) modal[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    rest = rest.slice(0, hashIdx);
  }
  let values = [];
  let customId = rest;
  const eq = rest.indexOf("=");
  if (eq !== -1) {
    customId = rest.slice(0, eq);
    values = rest.slice(eq + 1).split(",").filter(Boolean);
  }
  return { customId, values, modal };
}

async function applyStep(collector, step) {
  const detail = [
    step.values.length ? ` = ${step.values.join(",")}` : "",
    Object.keys(step.modal).length ? `  modal:${JSON.stringify(step.modal)}` : ""
  ].join("");
  console.log(`\n▶ STEP  ${step.customId}${detail}`);
  const i = makeComponentInteraction(step);
  if (collector._filter && !collector._filter(i)) {
    console.log("  (filtered out by the collector — user id mismatch; skipping)");
    return;
  }
  await collector.emitCollect(i);
}

async function endAll(reason) {
  for (const c of state.collectors) await c.emitEnd(reason);
}

async function driveScripted(steps) {
  for (const step of steps) {
    const collector = state.collectors[state.collectors.length - 1];
    if (!collector) { console.log("\n(no collector available; remaining steps ignored)"); break; }
    try {
      await applyStep(collector, step);
    } catch (err) {
      msgLog.error(`Step "${step.customId}" threw: ${err.message}`);
      break;
    }
    if (collector._stopped) {
      await collector.emitEnd(collector._stopReason);
      break;
    }
  }
  await endAll(END_REASON);
}

async function driveInteractive() {
  const readline = require("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, res));
  console.log("\nInteractive collector mode.");
  console.log("Enter a step:  customId[=v1,v2][#field=val;...]");
  console.log("Type 'end' (or blank) to finish via the collector's end handler, 'quit' to exit now.\n");
  for (;;) {
    const line = (await ask("step> ")).trim();
    if (line === "quit") { rl.close(); process.exit(0); }
    if (line === "" || line === "end") break;
    const collector = state.collectors[state.collectors.length - 1];
    if (!collector) { console.log("(no collector available)"); break; }
    try {
      await applyStep(collector, parseStep(line));
    } catch (err) {
      msgLog.error(`Step threw: ${err.message}`);
    }
    if (collector._stopped) { await collector.emitEnd(collector._stopReason); break; }
  }
  rl.close();
  await endAll("user-ended");
}

// ── Synthetic command interaction ────────────────────────────────────────────
function buildInteraction(commandName, opts) {
  const userId = (opts.as && opts.as !== true) ? String(opts.as) : (process.env.ADMIN_DISCORD_ID || "0");
  const username = (opts["as-name"] && opts["as-name"] !== true) ? String(opts["as-name"]) : "devtester";
  state.invokingUser = { id: userId, username, toString: () => `<@${userId}>` };

  const get = name => {
    const v = opts[name];
    return v === undefined ? null : v;
  };

  // options.data for reconstructCommand() logging.
  const optionData = Object.entries(opts)
    .filter(([ k ]) => !RESERVED.has(k))
    .map(([ name, value ]) => ({ name, value }));
  let data = optionData;
  if (opts.sub) data = [ { name: String(opts.sub), options: optionData } ];
  if (opts.group) data = [ { name: String(opts.group), options: data } ];

  const interaction = {
    commandName,
    user: state.invokingUser,
    replied: false,
    deferred: false,
    client: { user: { id: "dev-bot", tag: "dev-bot#0000" } },
    options: {
      getString: name => { const v = get(name); return v === null ? null : String(v); },
      getInteger: name => { const v = get(name); return v === null ? null : parseInt(v, 10); },
      getNumber: name => { const v = get(name); return v === null ? null : Number(v); },
      getBoolean: name => { const v = get(name); return v === null ? null : (v === true || v === "true"); },
      getUser: name => {
        const v = get(name);
        if (v === null) return null;
        const [ id, uname ] = String(v).split(":");
        return { id, username: uname || id, toString: () => `<@${id}>` };
      },
      getSubcommand: () => (opts.sub ? String(opts.sub) : null),
      getSubcommandGroup: () => (opts.group ? String(opts.group) : null),
      data
    },
    deferReply: async p => { interaction.deferred = true; render("DEFER REPLY", p || {}); },
    reply: async p => { interaction.replied = true; render("REPLY", p); return fakeMessage; },
    editReply: async p => { render("EDIT REPLY", p); return fakeMessage; },
    followUp: async p => { render("FOLLOW UP", p); return fakeMessage; },
    fetchReply: async () => fakeMessage,
    deleteReply: async () => { render("DELETE REPLY", {}); }
  };
  return interaction;
}

// ── Best-effort presence globals (info command reads these) ──────────────────
async function primeGlobals() {
  global.version = require("../package.json").version;
  try {
    global.commitHash = require("node:child_process")
      .execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch { global.commitHash = "unknown"; }

  global.serverCount = "?";
  global.userCount = "?";
  try {
    const s = await (await applicationApiCall("application/servers", "GET", null)).body.json();
    global.serverCount = s.data.length;
    const u = await (await applicationApiCall("application/users", "GET", null)).body.json();
    global.userCount = u.data.length;
  } catch { /* dev panel may be unreachable; leave placeholders */ }
}

function loadSteps(opts) {
  if (opts.script && opts.script !== true) {
    const raw = JSON.parse(fs.readFileSync(opts.script, "utf-8"));
    return raw.map(s => (typeof s === "string"
      ? parseStep(s)
      : { customId: s.customId, values: s.values || [], modal: s.modal || {} }));
  }
  if (opts.step === undefined) return [];
  return [].concat(opts.step).map(parseStep);
}

(async () => {
  const { positional, opts } = parseArgs(process.argv.slice(2));

  try {
    initDatabase();
  } catch (err) {
    msgLog.error(`Failed to initialize database: ${err.message}`);
    process.exit(1);
  }

  const commands = loadCommands();

  if (opts.list || positional.length === 0) {
    console.log("Available commands:");
    for (const [ name, cmd ] of commands) {
      console.log(`  ${name.padEnd(18)} ${cmd.data.description || ""}`);
    }
    console.log("\nUsage: node scripts/dev-run.js <command> [--option=value ...] [--step <dsl> ...] [--interactive]");
    process.exit(0);
  }

  const name = positional[0];
  const command = commands.get(name);
  if (!command) {
    msgLog.error(`No such command: ${name}. Run with --list to see available commands.`);
    process.exit(1);
  }

  const steps = loadSteps(opts);
  const interactive = opts.interactive === true;
  if (opts["end-reason"] && opts["end-reason"] !== true) END_REASON = String(opts["end-reason"]);

  await primeGlobals();

  const interaction = buildInteraction(name, opts);
  try {
    await command.execute(interaction);

    if (interactive) {
      await driveInteractive();
    } else if (steps.length) {
      await driveScripted(steps);
    } else if (state.collectors.length) {
      console.log("\n(interactive collector attached — pass --step or --interactive to drive it)");
    }

    console.log("\n✓ execute() resolved.");
    process.exit(0);
  } catch (err) {
    msgLog.error(`Command threw: ${err.message}`);
    msgLog.debugExtended ? msgLog.debugExtended(err) : console.error(err);
    process.exit(1);
  }
})();
