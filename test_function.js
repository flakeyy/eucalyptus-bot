const { editServerBuild } = require("./utility/server_functions.js");

async function runTest() {
  try {
    const output = await editServerBuild(40, "memory", 2048);
    console.log(output);
  } catch (error) {
    console.error("Error:", error);
    console.error("\nStack trace:");
    console.error(error.stack);
  }
}

runTest();