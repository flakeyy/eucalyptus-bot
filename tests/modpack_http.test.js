jest.mock("../utility/url_validation.js", () => ({
  validateExternalUrl: jest.fn(async () => ({ ok: true }))
}));

const http = require("../utility/modpack_http.js");
const { validateExternalUrl } = require("../utility/url_validation.js");

/* global ReadableStream */
function streamResponse(bytes, { ok = true, status = 200, contentLength } = {}) {
  const body = new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); }
  });
  const cl = contentLength ?? bytes.length;
  return {
    ok,
    status,
    headers: { get: name => (name === "content-length" ? String(cl) : null) },
    body
  };
}

describe("downloadFile", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    validateExternalUrl.mockResolvedValue({ ok: true });
  });

  test("returns a Buffer of the response body", async () => {
    global.fetch = jest.fn().mockResolvedValue(streamResponse(new Uint8Array([ 1, 2, 3 ])));
    const buf = await http.downloadFile("https://cdn.example.com/a.jar");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect([ ...buf ]).toEqual([ 1, 2, 3 ]);
  });

  test("throws when URL validation rejects the host (SSRF guard)", async () => {
    validateExternalUrl.mockResolvedValue({ ok: false, reason: "non-public address" });
    global.fetch = jest.fn();
    await expect(http.downloadFile("https://169.254.169.254/")).rejects.toThrow(/URL rejected/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = jest.fn().mockResolvedValue(streamResponse(new Uint8Array([ 1 ]), { ok: false, status: 404 }));
    await expect(http.downloadFile("https://cdn.example.com/missing.jar")).rejects.toThrow("HTTP 404");
  });

  test("uses manual redirect handling so each hop is re-validated", async () => {
    global.fetch = jest.fn().mockResolvedValue(streamResponse(new Uint8Array([ 9 ])));
    await http.downloadFile("https://cdn.example.com/a.jar");
    expect(global.fetch).toHaveBeenCalledWith("https://cdn.example.com/a.jar", { redirect: "manual" });
  });

  test("re-validates redirect targets and rejects an internal Location (SSRF guard)", async () => {
    // Initial public URL passes; the redirect target resolves to a blocked host.
    validateExternalUrl.mockImplementation(async url =>
      url.includes("169.254.169.254")
        ? { ok: false, reason: "non-public address" }
        : { ok: true });
    const redirect = {
      ok: false,
      status: 302,
      headers: { get: name => (name === "location" ? "https://169.254.169.254/latest/meta-data/" : null) },
      body: null
    };
    global.fetch = jest.fn().mockResolvedValue(redirect);

    await expect(http.downloadFile("https://attacker.example/pack.jar")).rejects.toThrow(/URL rejected/);
    // First hop fetched, second hop blocked before any fetch to the internal host.
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test("follows a redirect to another allowed host", async () => {
    validateExternalUrl.mockResolvedValue({ ok: true });
    const redirect = {
      ok: false,
      status: 301,
      headers: { get: name => (name === "location" ? "https://cdn2.example.com/a.jar" : null) },
      body: null
    };
    global.fetch = jest.fn()
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(streamResponse(new Uint8Array([ 7, 7 ])));
    const buf = await http.downloadFile("https://cdn.example.com/a.jar");
    expect([ ...buf ]).toEqual([ 7, 7 ]);
    expect(global.fetch).toHaveBeenNthCalledWith(2, "https://cdn2.example.com/a.jar", { redirect: "manual" });
  });
});

describe("downloadToBuffer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    validateExternalUrl.mockResolvedValue({ ok: true });
  });

  test("returns chunks plus fileSize and reports final progress", async () => {
    global.fetch = jest.fn().mockResolvedValue(streamResponse(new Uint8Array([ 1, 2, 3, 4 ])));
    const onProgress = jest.fn();
    const { chunks, fileSize } = await http.downloadToBuffer("https://cdn.example.com/pack.zip", onProgress);
    expect(fileSize).toBe(4);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([ 1, 2, 3, 4 ]));
    expect(onProgress).toHaveBeenLastCalledWith(4, 4);
  });
});

describe("uploadBufferToServer", () => {
  test("posts a multipart body containing the file and returns the response", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const res = await http.uploadBufferToServer("https://wings.example.com/upload", "pack.zip", Buffer.from("DATA"));

    expect(res.ok).toBe(true);
    const [ url, opts ] = global.fetch.mock.calls[0];
    expect(url).toBe("https://wings.example.com/upload");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=WingsBoundary/);
    const body = opts.body.toString("utf8");
    expect(body).toContain("Content-Disposition: form-data; name=\"files\"; filename=\"pack.zip\"");
    expect(body).toContain("DATA");
  });
});

describe("streamUploadToServer", () => {
  test("throws on a non-2xx response", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(
      http.streamUploadToServer("https://wings.example.com/upload", "f.zip", [ new Uint8Array([ 1 ]) ], 1)
    ).rejects.toThrow("Upload failed: HTTP 500");
  });
});
