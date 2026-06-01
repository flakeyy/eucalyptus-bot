/* global TextEncoder, ReadableStream */
// Shared HTTP plumbing for modpack installs: SSRF-guarded downloads and
// multipart uploads to the Pterodactyl/Wings file-upload endpoint.
const { validateExternalUrl } = require("./url_validation.js");

const THROTTLE_MS = 2500;

// Builds the multipart/form-data envelope used by the Wings files/upload endpoint.
// Returns the boundary plus the encoded part header/footer for a single "files" field.
function buildMultipart(filename) {
  const boundary = `WingsBoundary${Date.now()}`;
  const enc = new TextEncoder();
  const partHeader = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const partFooter = enc.encode(`\r\n--${boundary}--\r\n`);
  return { boundary, partHeader, partFooter };
}

// Downloads a URL into an array of chunks, validating it first (SSRF guard).
// onDownloadProgress(downloadedBytes, totalBytes) is called (throttled) when a
// content-length is present. Returns { chunks, fileSize }.
async function downloadToBuffer(downloadUrl, onDownloadProgress) {
  const urlCheck = await validateExternalUrl(downloadUrl);
  if (!urlCheck.ok) {
    throw Object.assign(new Error(`URL rejected: ${urlCheck.reason}`), { isDownload: true });
  }
  const dlResponse = await fetch(downloadUrl);
  if (!dlResponse.ok) throw Object.assign(new Error(`Download failed: HTTP ${dlResponse.status}`), { isDownload: true });

  const fileSize = parseInt(dlResponse.headers.get("content-length") || "0", 10);
  const hasSize = fileSize > 0;
  let lastProgressAt = 0;

  const chunks = [];
  let downloadBytes = 0;
  const dlReader = dlResponse.body.getReader();
  while (true) {
    const { done, value } = await dlReader.read();
    if (done) break;
    chunks.push(value);
    downloadBytes += value.length;
    if (onDownloadProgress && hasSize) {
      const now = Date.now();
      if (now - lastProgressAt >= THROTTLE_MS) {
        lastProgressAt = now;
        onDownloadProgress(downloadBytes, fileSize);
      }
    }
  }
  if (onDownloadProgress && hasSize) onDownloadProgress(fileSize, fileSize);
  return { chunks, fileSize };
}

// Downloads a single (validated) URL fully into a Buffer. Throws on rejection or
// non-2xx so callers can count failures.
async function downloadFile(downloadUrl) {
  const urlCheck = await validateExternalUrl(downloadUrl);
  if (!urlCheck.ok) throw new Error(`URL rejected: ${urlCheck.reason}`);
  const res = await fetch(downloadUrl);
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

// Uploads a single in-memory buffer as multipart/form-data. Returns the fetch
// Response so callers can inspect .ok / .status.
async function uploadBufferToServer(uploadUrl, filename, buffer) {
  const { boundary, partHeader, partFooter } = buildMultipart(filename);
  const bodyBuf = Buffer.concat([ partHeader, buffer, partFooter ]);
  return fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(bodyBuf.length)
    },
    body: bodyBuf
  });
}

// Streams an array of chunks as multipart/form-data without buffering the whole
// body, for large archive uploads. onProgress(downloadBytes, uploadBytes, fileSize)
// is called (throttled). Throws on a non-2xx response.
async function streamUploadToServer(uploadUrl, filename, chunks, fileSize, onProgress) {
  const hasSize = fileSize > 0;
  let lastProgressAt = 0;

  const { boundary, partHeader, partFooter } = buildMultipart(filename);

  const uploadHeaders = { "Content-Type": `multipart/form-data; boundary=${boundary}` };
  if (hasSize) {
    uploadHeaders["Content-Length"] = String(partHeader.length + fileSize + partFooter.length);
  }

  let uploadBytes = 0;
  let chunkIdx = 0;
  let headerSent = false;

  const body = new ReadableStream({
    pull(controller) {
      if (!headerSent) {
        controller.enqueue(partHeader);
        headerSent = true;
      } else if (chunkIdx < chunks.length) {
        const chunk = chunks[chunkIdx++];
        uploadBytes += chunk.length;
        if (onProgress && hasSize) {
          const now = Date.now();
          if (now - lastProgressAt >= THROTTLE_MS) {
            lastProgressAt = now;
            onProgress(fileSize, uploadBytes, fileSize);
          }
        }
        controller.enqueue(chunk);
      } else {
        controller.enqueue(partFooter);
        controller.close();
      }
    }
  });

  const uploadResponse = await fetch(uploadUrl, { method: "POST", headers: uploadHeaders, body, duplex: "half" });
  if (!uploadResponse.ok) throw Object.assign(new Error(`Upload failed: HTTP ${uploadResponse.status}`), { isUpload: true });
}

module.exports = {
  buildMultipart,
  downloadToBuffer,
  downloadFile,
  uploadBufferToServer,
  streamUploadToServer
};
