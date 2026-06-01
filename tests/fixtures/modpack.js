// Shared helpers for install_modpack tests.
// Requires the caller to have already mocked utility/server_functions.js and
// global.fetch — this module only provides convenience builders.

function makeState(overrides = {}) {
  return {
    source: "curseforge",
    serverId: "abc123",
    serverInternalId: 42,
    serverName: "Test Server",
    modpackName: "Star Technology",
    targetFile: {
      id: 1,
      displayName: "startech-server.zip",
      downloadUrl: "https://cdn.example.com/pack.zip"
    },
    loaderType: "forge",
    usingClientPack: false,
    ...overrides
  };
}

/* global ReadableStream */
function makeStreamResponse(bytes = new Uint8Array([ 1, 2, 3, 4 ])) {
  const body = new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); }
  });
  return {
    ok: true,
    status: 200,
    headers: { get: name => name === "content-length" ? String(bytes.length) : null },
    body
  };
}

// Wire up the happy-path mock returns for server_functions and global.fetch.
// Pass the already-required serverFunctions module so we don't reach across
// jest's module registry from inside the fixture.
function mockHappyPath(serverFunctions, { firstListResult = [] } = {}) {
  serverFunctions.setServerPowerState.mockResolvedValue({ statusCode: 204 });
  serverFunctions.getServerResourceInfoById.mockResolvedValue({
    statusCode: 200,
    body: { json: async () => ({ attributes: { current_state: "offline" } }) }
  });
  serverFunctions.listServerFiles.mockResolvedValue(firstListResult);
  serverFunctions.deleteServerFiles.mockResolvedValue(204);
  serverFunctions.changeServerEgg.mockResolvedValue(200);
  serverFunctions.getFileUploadUrl.mockResolvedValue("https://wings.example.com/upload?token=x");
  serverFunctions.decompressFile.mockResolvedValue(204);
  global.fetch = jest.fn()
    .mockResolvedValueOnce(makeStreamResponse())  // download
    .mockResolvedValueOnce({ ok: true });         // upload
}

// Configure server_functions for an installation that gets past the
// pre-flight steps but fails at the download/upload boundary. Caller sets
// global.fetch / getFileUploadUrl to control the failure point.
function mockUpToTransfer(serverFunctions) {
  serverFunctions.setServerPowerState.mockResolvedValue({ statusCode: 204 });
  serverFunctions.getServerResourceInfoById.mockResolvedValue({
    statusCode: 200,
    body: { json: async () => ({ attributes: { current_state: "offline" } }) }
  });
  serverFunctions.listServerFiles.mockResolvedValue([]);
  serverFunctions.deleteServerFiles.mockResolvedValue(204);
  serverFunctions.changeServerEgg.mockResolvedValue(200);
}

module.exports = { makeState, makeStreamResponse, mockHappyPath, mockUpToTransfer };
