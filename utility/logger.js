const fs = require("fs").promises;
const path = require("path");

const logDir = path.join(__dirname, "../logs");

// Create log directory asynchronously on module load
(async () => {
  try {
    await fs.mkdir(logDir, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") {
      console.error("Error creating log directory:", err);
    }
  }
})();

const dateStr = new Date().toISOString().slice(0, 10); // yyyy-mm-dd
const logFile = path.join(logDir, `${dateStr}.log`);
const latestLogFile = path.join(logDir, "latest.log");

function msgLog(level, ...args) {
  const timestamp = new Date().toISOString();
  const msg = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const line = `[${timestamp}] [${level}] ${msg}\n`;
  fs.appendFile(logFile, line, err => {
    if (err) {
      console.error("Error writing to log file:", err);
    }
  });
  fs.appendFile(latestLogFile, line, err => {
    if (err) {
      console.error("Error writing to latest log file:", err);
    }
  });
  console[level](...args);
}

module.exports = {
  log: (...args) => msgLog("info", ...args),
  warn: (...args) => msgLog("warn", ...args),
  error: (...args) => msgLog("error", ...args),
  debug: (...args) => msgLog("debug", ...args)
};
