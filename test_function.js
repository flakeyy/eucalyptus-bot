const { editServerBuild } = require("./utility/server_functions.js");
const msgLog = require("./utility/logger.js");

async function runTest() {
  msgLog.log("this is a log")
  msgLog.warn("USER1", '|', "multiline test\n\nnextline")
  msgLog.error("this is a error")
  msgLog.debug("debug message")
}

runTest();