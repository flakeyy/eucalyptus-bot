const fs = require("fs");
const path = require("path");

const logDir = path.join(__dirname, "../logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

const dateStr = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
const logFile = path.join(logDir, `${dateStr}.log`);
const latestLogFile = path.join(logDir, "latest.log");

function msgLog(level, ...args) {
  const timestamp = new Date().toISOString();
  const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${timestamp}] [${level}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
  fs.appendFileSync(latestLogFile, line);
  // Also output to console
  console[level](...args);
}

module.exports = {
  log: (...args) => msgLog("info", ...args),
  warn: (...args) => msgLog("warn", ...args),
  error: (...args) => msgLog("error", ...args),
  debug: (...args) => msgLog("debug", ...args)
};
