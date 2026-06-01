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
