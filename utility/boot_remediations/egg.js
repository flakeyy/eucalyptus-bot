"use strict";

const msgLog = require("../logger.js");
const {
  listServerFiles, getFileContents, writeServerFile, deleteServerFiles, getServerInfoById
} = require("../server_functions.js");
const { applicationApiCall } = require("../helper_functions.js");

function insertJvmFlagBeforeMainClass(argfileText, flag) {
  if (!argfileText) return argfileText;
  const text = argfileText.replace(/-Djava\.awt\.headless=false\b/g, "");
  if (text.includes("java.awt.headless")) return text;
  const lines = text.split(/\r?\n/);
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith("#")) {
      insertAt = i + 1;
      continue;
    }
    if (
      t.startsWith("-X") || t.startsWith("-D") || t.startsWith("-javaagent") ||
      t === "-cp" || t === "-classpath" || t === "--add-opens" || t === "--add-exports" ||
      t.startsWith("--add-opens=") || t.startsWith("--add-exports=")
    ) {
      insertAt = i + 1;
      if (t === "-cp" || t === "-classpath" || t === "--add-opens" || t === "--add-exports") {
        insertAt = Math.min(i + 2, lines.length);
      }
      continue;
    }
    break;
  }
  lines.splice(insertAt, 0, flag);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function looksLikeValidJvmArgfile(text) {
  if (!text || text.length < 20) return false;
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  return /-jar|\bnogui\b|cpw\.mods|neoforged|minecraftforge|fabricmc|BootstrapLauncher/i.test(text);
}

async function writeServerFileOk(ctx, filePath, contents) {
  for (let tryNum = 1; tryNum <= 3; tryNum++) {
    const status = await writeServerFile(ctx.serverId, ctx.userId, filePath, contents);
    if (status === 204 || status === 200) return true;
    msgLog.warn(`[boot-verify] ${ctx.serverId}: write ${filePath} returned ${status} (try ${tryNum}/3)`);
    await new Promise(r => setTimeout(r, 1500 * tryNum));
  }
  return false;
}

async function removeServerIconFiles(ctx) {
  const names = new Set([ "server-icon.png", "server-icon.jpg", "server-icon.jpeg", "icon.png" ]);
  const root = await listServerFiles(ctx.serverId, ctx.userId, "/").catch(() => null);
  for (const f of root ?? []) {
    const name = f.attributes?.name;
    if (name && /server-?icon/i.test(name)) names.add(name);
  }
  const list = [ ...names ];
  if (list.length === 0) return 0;
  await deleteServerFiles(ctx.serverId, ctx.userId, list).catch(() => {});
  return list.length;
}

function stripEggStartupWrappers(startup) {
  let s = String(startup ?? "").trim();
  if (!s) return s;
  for (let i = 0; i < 8; i++) {
    const next = s
      .replace(/^\s*rm -f server-icon\.png server-icon\.jpg server-icon\.jpeg\s*;\s*/i, "")
      .replace(/^\s*export\s+JAVA_TOOL_OPTIONS=\S+\s*;\s*/i, "")
      .replace(/^\s*export\s+_JAVA_OPTIONS=\S+\s*;\s*/i, "")
      .replace(/^\s*export\s+LD_LIBRARY_PATH=[^\n;]*;?\s*/i, "")
      .replace(/^\s*LD_LIBRARY_PATH="[^"]*"\s+/i, "")
      .replace(/^\s*_JAVA_OPTIONS=\S+\s+/i, "")
      .replace(/^\s*JAVA_TOOL_OPTIONS=\S+\s+/i, "")
      .replace(/^\s*LD_LIBRARY_PATH=\S+\s+/i, "")
      .replace(/^\s*DISPLAY=\s*/i, "")
      .replace(/\s+-Djava\.awt\.headless=true\b/g, "")
      .trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

async function patchEggStartup(ctx, mutate) {
  try {
    const infoRes = await getServerInfoById(ctx.serverId, ctx.userId);
    if (infoRes.statusCode !== 200) return false;
    const info = await infoRes.body.json();
    const internalId = info?.attributes?.internal_id;
    if (!internalId) return false;
    const appRes = await applicationApiCall(`application/servers/${internalId}`, "GET");
    if (appRes.statusCode !== 200) return false;
    const app = await appRes.body.json();
    const attrs = app?.attributes;
    const container = attrs?.container;
    if (!attrs || !container) return false;

    const beforeStartup = String(container.startup_command ?? attrs.startup ?? "");
    const environment = { ...(container.environment ?? {}) };
    const result = mutate({ startup: beforeStartup, environment });
    if (!result || result.changed === false) return true;

    const startup = result.startup ?? beforeStartup;
    const body = JSON.stringify({
      startup,
      environment: result.environment ?? environment,
      egg: attrs.egg ?? attrs.egg_id,
      image: container.image,
      skip_scripts: true
    });
    const patch = await applicationApiCall(`application/servers/${internalId}/startup`, "PATCH", body);
    if (patch.statusCode === 200 || patch.statusCode === 204) {
      msgLog.log(`[boot-verify] ${ctx.serverId}: patched egg startup (${result.reason || "updated"})`);
      return true;
    }
    msgLog.warn(`[boot-verify] ${ctx.serverId}: startup patch returned ${patch.statusCode}`);
    return false;
  } catch (err) {
    msgLog.warn(`[boot-verify] ${ctx.serverId}: startup patch failed: ${err.message}`);
    return false;
  }
}

async function ensureHeadlessInEggStartup(ctx) {
  const flag = "-Djava.awt.headless=true";
  return patchEggStartup(ctx, ({ startup, environment }) => {
    let changed = false;
    const cleaned = stripEggStartupWrappers(startup);
    if (cleaned !== startup) {
      startup = cleaned;
      changed = true;
    }
    {
      const cur = String(environment.JAVA_TOOL_OPTIONS ?? "");
      if (!cur.includes("java.awt.headless")) {
        environment.JAVA_TOOL_OPTIONS = `${cur} ${flag}`.trim();
        changed = true;
      }
    }
    {
      const cur = String(environment._JAVA_OPTIONS ?? "");
      if (!cur.includes("java.awt.headless")) {
        environment._JAVA_OPTIONS = `${cur} ${flag}`.trim();
        changed = true;
      }
    }
    if (!Object.prototype.hasOwnProperty.call(environment, "DISPLAY") || environment.DISPLAY) {
      environment.DISPLAY = "";
      changed = true;
    }
    for (const key of [ "JAVA_ARGS", "EXTRA_ARGS", "JVM_ARGS", "JVM_OPTIONS" ]) {
      if (!(key in environment)) continue;
      const cur = String(environment[key] ?? "");
      if (cur.includes("java.awt.headless")) continue;
      environment[key] = `${cur} ${flag}`.trim();
      changed = true;
    }
    if (!changed) return { changed: false };
    return {
      startup,
      environment,
      changed: true,
      reason: "headless env (+unwrap prior startup hacks)"
    };
  });
}

async function ensureNoguiInUnixArgs(ctx) {
  const patch = async rel => {
    const text = await getFileContents(ctx.serverId, ctx.userId, `/${rel}`);
    if (!text || !looksLikeValidJvmArgfile(text)) return false;
    if (/(?:^|\s)nogui(?:\s|$)/m.test(text)) return true;
    const next = `${text.trimEnd()}\nnogui\n`;
    if (await writeServerFileOk(ctx, `/${rel}`, next)) {
      msgLog.log(`[boot-verify] ${ctx.serverId}: appended nogui to /${rel}`);
      return true;
    }
    return false;
  };
  let ok = await patch("unix_args.txt");
  for (const base of [
    "libraries/net/minecraftforge/forge",
    "libraries/net/neoforged/neoforge"
  ]) {
    const versions = await listServerFiles(ctx.serverId, ctx.userId, `/${base}`).catch(() => null);
    for (const v of versions ?? []) {
      const ver = v.attributes?.name;
      if (!ver || v.attributes?.is_file) continue;
      if (await patch(`${base}/${ver}/unix_args.txt`)) ok = true;
    }
  }
  return ok;
}

async function ensureHeadlessJvmArgs(ctx) {
  const flag = "-Djava.awt.headless=true";
  let applied = false;

  if (await ensureHeadlessInEggStartup(ctx)) applied = true;

  {
    const name = "user_jvm_args.txt";
    const existing = await getFileContents(ctx.serverId, ctx.userId, `/${name}`);
    if (existing === null) {
      const root = await listServerFiles(ctx.serverId, ctx.userId, "/").catch(() => null);
      const present = (root ?? []).some(f => f.attributes?.name === name);
      if (present) {
        msgLog.warn(`[boot-verify] ${ctx.serverId}: skip ${name} headless — could not read existing file`);
      } else if (await writeServerFileOk(ctx, `/${name}`, `${flag}\n`)) {
        msgLog.log(`[boot-verify] ${ctx.serverId}: wrote ${flag} to /${name}`);
        applied = true;
      }
    } else if (existing.includes("java.awt.headless")) {
      applied = true;
    } else {
      const next = existing.trim() ? `${existing.trim()}\n${flag}\n` : `${flag}\n`;
      if (await writeServerFileOk(ctx, `/${name}`, next)) {
        msgLog.log(`[boot-verify] ${ctx.serverId}: wrote ${flag} to /${name}`);
        applied = true;
      }
    }
  }

  {
    let unix = await getFileContents(ctx.serverId, ctx.userId, "/unix_args.txt");
    let libraryPath = null;
    if ((!unix || !looksLikeValidJvmArgfile(unix)) && !unix?.includes("java.awt.headless")) {
      for (const base of [
        "libraries/net/minecraftforge/forge",
        "libraries/net/neoforged/neoforge"
      ]) {
        const versions = await listServerFiles(ctx.serverId, ctx.userId, `/${base}`).catch(() => null);
        for (const v of versions ?? []) {
          const ver = v.attributes?.name;
          if (!ver || v.attributes?.is_file) continue;
          const rel = `${base}/${ver}/unix_args.txt`;
          const candidate = await getFileContents(ctx.serverId, ctx.userId, `/${rel}`);
          if (candidate && looksLikeValidJvmArgfile(candidate)) {
            unix = candidate;
            libraryPath = rel;
            break;
          }
        }
        if (unix && looksLikeValidJvmArgfile(unix)) break;
      }
    }
    if (unix && unix.includes("java.awt.headless")) {
      applied = true;
    } else if (unix && looksLikeValidJvmArgfile(unix)) {
      const next = insertJvmFlagBeforeMainClass(unix, flag);
      const wroteRoot = await writeServerFileOk(ctx, "/unix_args.txt", next);
      const wroteLib = libraryPath
        ? await writeServerFileOk(ctx, `/${libraryPath}`, next)
        : false;
      if (wroteRoot) {
        msgLog.log(`[boot-verify] ${ctx.serverId}: inserted ${flag} into /unix_args.txt`);
        applied = true;
      }
      if (wroteLib) {
        msgLog.log(`[boot-verify] ${ctx.serverId}: inserted ${flag} into /${libraryPath}`);
        applied = true;
      }
      if (wroteLib && !wroteRoot) {
        await deleteServerFiles(ctx.serverId, ctx.userId, [ "unix_args.txt" ]).catch(() => {});
        if (await writeServerFileOk(ctx, "/unix_args.txt", next)) {
          msgLog.log(`[boot-verify] ${ctx.serverId}: rewrote /unix_args.txt after library patch`);
          applied = true;
        }
      }
    }
  }

  if (await ensureNoguiInUnixArgs(ctx)) applied = true;
  return applied;
}

async function repairMissingServerJar(ctx, consoleTail = "") {
  if (!/Unable to access jarfile/i.test(consoleTail)) return false;
  const root = await listServerFiles(ctx.serverId, ctx.userId, "/").catch(() => null);
  const names = (root ?? []).map(f => f.attributes?.name).filter(Boolean);
  const jar =
    names.find(n => /^forge-.*-universal\.jar$/i.test(n)) ||
    names.find(n => /^forge-.*\.jar$/i.test(n) && !/installer/i.test(n)) ||
    names.find(n => /^neoforge-.*\.jar$/i.test(n) && !/installer/i.test(n)) ||
    names.find(n => /^minecraft_server.*\.jar$/i.test(n)) ||
    names.find(n => n === "server.jar");
  if (!jar) {
    for (const base of [
      "libraries/net/minecraftforge/forge",
      "libraries/net/neoforged/neoforge"
    ]) {
      const versions = await listServerFiles(ctx.serverId, ctx.userId, `/${base}`).catch(() => null);
      for (const v of versions ?? []) {
        const ver = v.attributes?.name;
        if (!ver || v.attributes?.is_file) continue;
        const files = await listServerFiles(ctx.serverId, ctx.userId, `/${base}/${ver}`).catch(() => null);
        const hit = (files ?? [])
          .map(f => f.attributes?.name)
          .find(n => n && /\.jar$/i.test(n) && !/installer|shim/i.test(n));
        if (hit) {
          return patchEggStartup(ctx, ({ startup, environment }) => {
            const cleaned = stripEggStartupWrappers(startup);
            environment.SERVER_JARFILE = `${base}/${ver}/${hit}`;
            if ("SERVER_JAR" in environment) environment.SERVER_JAR = environment.SERVER_JARFILE;
            return {
              startup: cleaned,
              environment,
              changed: true,
              reason: `SERVER_JARFILE=${environment.SERVER_JARFILE}`
            };
          });
        }
      }
    }
  }
  if (!jar) {
    const hasUnix = names.includes("unix_args.txt") || names.includes("user_jvm_args.txt");
    if (hasUnix) {
      return patchEggStartup(ctx, ({ startup, environment }) => {
        const cleaned = stripEggStartupWrappers(startup);
        let next = cleaned;
        if (/server\.jar/i.test(next) && !/@unix_args/i.test(next)) {
          next = next.replace(
            /-jar\s+\{\{SERVER_JARFILE\}\}|-jar\s+server\.jar/i,
            "@unix_args.txt"
          );
        }
        if (next === cleaned && String(environment.SERVER_JARFILE ?? "") === "server.jar") {
          return { startup: cleaned, environment, changed: cleaned !== startup, reason: "unwrap after missing server.jar" };
        }
        return {
          startup: next,
          environment,
          changed: next !== startup,
          reason: "prefer @unix_args over missing server.jar"
        };
      });
    }
    msgLog.warn(`[boot-verify] ${ctx.serverId}: Unable to access jarfile but no forge/server jar found`);
    return false;
  }
  return patchEggStartup(ctx, ({ startup, environment }) => {
    const cleaned = stripEggStartupWrappers(startup);
    const cur = String(environment.SERVER_JARFILE ?? environment.SERVER_JAR ?? "");
    if (cur === jar && names.includes(cur) && cleaned === startup) return { changed: false };
    environment.SERVER_JARFILE = jar;
    if ("SERVER_JAR" in environment) environment.SERVER_JAR = jar;
    msgLog.warn(`[boot-verify] ${ctx.serverId}: set SERVER_JARFILE=${jar}`);
    return {
      startup: cleaned,
      environment,
      changed: true,
      reason: `SERVER_JARFILE=${jar}`
    };
  });
}

async function repairCorruptedUnixArgs(ctx, consoleTail = "") {
  if (
    !/Could not find or load main class @unix_args/i.test(consoleTail) &&
    !/Usage: java|enable system assertions|--help-extra/i.test(consoleTail)
  ) {
    return false;
  }
  const cur = await getFileContents(ctx.serverId, ctx.userId, "/unix_args.txt");
  if (cur && /-jar|\bnogui\b|cpw\.mods|neoforged|minecraftforge|fabricmc/i.test(cur) &&
      cur.split("\n").length > 3) {
    return false;
  }

  const tryCopy = async rel => {
    const text = await getFileContents(ctx.serverId, ctx.userId, `/${rel}`);
    if (!text || text.length < 20) return false;
    if (!/-jar|\bnogui\b|cpw\.mods|neoforged|minecraftforge/i.test(text)) return false;
    await writeServerFile(ctx.serverId, ctx.userId, "/unix_args.txt", text);
    msgLog.warn(`[boot-verify] ${ctx.serverId}: restored /unix_args.txt from /${rel}`);
    return true;
  };

  for (const base of [
    "libraries/net/minecraftforge/forge",
    "libraries/net/neoforged/neoforge"
  ]) {
    const versions = await listServerFiles(ctx.serverId, ctx.userId, `/${base}`).catch(() => null);
    for (const v of versions ?? []) {
      const ver = v.attributes?.name;
      if (!ver || v.attributes?.is_file) continue;
      if (await tryCopy(`${base}/${ver}/unix_args.txt`)) return true;
      if (await tryCopy(`${base}/${ver}/win_args.txt`)) return true;
    }
  }
  return false;
}

module.exports = {
  insertJvmFlagBeforeMainClass,
  looksLikeValidJvmArgfile,
  writeServerFileOk,
  removeServerIconFiles,
  stripEggStartupWrappers,
  patchEggStartup,
  ensureHeadlessInEggStartup,
  ensureNoguiInUnixArgs,
  ensureHeadlessJvmArgs,
  repairMissingServerJar,
  repairCorruptedUnixArgs
};
