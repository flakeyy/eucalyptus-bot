// Standalone test script for mod_inspector.js
// Usage: node scripts/test_mod_inspector.js [--loader fabric|quilt|forge|neoforge] <url-or-path-or-folder> [...]
//
// --loader  Optional: simulate a specific modpack loader so universal/multi-loader JARs
//           are evaluated against the correct metadata file.
//
// Accepts any mix of:
//   - https:// URLs  (downloaded with fetch)
//   - Local .jar file paths
//   - Local folder paths (all *.jar files inside are scanned)
//
// Prints a results table and summary. Does not use the cache.

const fs = require("fs");
const path = require("path");
const { inspectModJar } = require("../utility/mod_inspector.js");

async function downloadUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const chunks = [];
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function collectJarsFromArg(arg) {
  if (arg.startsWith("https://") || arg.startsWith("http://")) {
    return [ { type: "url", value: arg, label: arg.split("/").pop() || arg } ];
  }
  const stat = fs.statSync(arg, { throwIfNoEntry: false });
  if (!stat) {
    console.error(`Not found: ${arg}`);
    return [];
  }
  if (stat.isDirectory()) {
    return fs.readdirSync(arg)
      .filter(f => f.endsWith(".jar"))
      .map(f => ({ type: "file", value: path.join(arg, f), label: f }));
  }
  return [ { type: "file", value: arg, label: path.basename(arg) } ];
}

async function getBuffer(item) {
  if (item.type === "url") return downloadUrl(item.value);
  return fs.readFileSync(item.value);
}

const VALID_LOADERS = new Set([ "fabric", "quilt", "forge", "neoforge" ]);

async function main() {
  let args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: node scripts/test_mod_inspector.js [--loader fabric|quilt|forge|neoforge] <url-or-path-or-folder> [...]");
    process.exit(0);
  }

  let loaderType = null;
  if (args[0] === "--loader") {
    if (!VALID_LOADERS.has(args[1])) {
      console.error(`Invalid loader "${args[1]}". Valid: ${[ ...VALID_LOADERS ].join(", ")}`);
      process.exit(1);
    }
    loaderType = args[1];
    args = args.slice(2);
  }

  const items = args.flatMap(collectJarsFromArg);
  if (items.length === 0) {
    console.log("No .jar files found.");
    process.exit(0);
  }

  const COL = { name: 50, loader: 10, source: 30, result: 13 };
  const header = [
    "Filename".padEnd(COL.name),
    "Loader".padEnd(COL.loader),
    "Source File".padEnd(COL.source),
    "Client-only?"
  ].join("  ");
  const divider = "-".repeat(header.length);

  const loaderNote = loaderType ? ` (loader: ${loaderType})` : "";
  console.log(`\nInspecting ${items.length} mod(s)${loaderNote}...\n`);
  console.log(header);
  console.log(divider);

  let clientOnly = 0;
  let serverCompat = 0;
  let unknown = 0;
  let errors = 0;

  for (const item of items) {
    let result;
    try {
      const buffer = await getBuffer(item);
      result = inspectModJar(buffer, loaderType);
    } catch (e) {
      console.log(
        item.label.slice(0, COL.name).padEnd(COL.name) + "  " +
        "error".padEnd(COL.loader) + "  " +
        e.message.slice(0, COL.source).padEnd(COL.source) + "  " +
        "ERROR"
      );
      errors++;
      continue;
    }

    const isClient = result.verdict === "client";
    if (result.source === "no-metadata" || result.source === "error") unknown++;
    else if (isClient) clientOnly++;
    else serverCompat++;

    const tag = isClient ? `CLIENT-ONLY (${result.confidence})` : (result.source === "no-metadata" ? "unknown" : "server-compat");
    console.log(
      item.label.slice(0, COL.name).padEnd(COL.name) + "  " +
      (result.loader ?? "-").padEnd(COL.loader) + "  " +
      result.source.padEnd(COL.source) + "  " +
      tag
    );
  }

  console.log(divider);
  console.log(`\nResults: ${clientOnly} client-only | ${serverCompat} server-compat | ${unknown} unknown (no metadata) | ${errors} errors`);
}

main().catch(e => { console.error(e); process.exit(1); });
