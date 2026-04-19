"use strict";

const EventEmitter = require("events");
const WebSocket = require("ws");
const { clientApiCall } = require("./helper_functions.js");
const msgLog = require("./logger.js");

const RECONNECT_DELAY_MS = 2000;

class PterodactylWebSocket extends EventEmitter {
  constructor(serverId, userDiscordId) {
    super();
    this._serverId = serverId;
    this._userId = userDiscordId;
    this._ws = null;
    this._closed = false;
    this._reconnecting = false;
  }

  async connect() {
    if (this._closed) return;
    const { token, socketUrl } = await this._fetchToken();
    this._openSocket(socketUrl, token);
  }

  close() {
    this._closed = true;
    if (this._ws) {
      this._ws.removeAllListeners();
      this._ws.terminate();
      this._ws = null;
    }
    this.emit("close");
  }

  async _fetchToken() {
    const res = await clientApiCall(`client/servers/${this._serverId}/websocket`, "GET", null, this._userId);
    const data = await res.body.json();
    return { token: data.data.token, socketUrl: data.data.socket };
  }

  _openSocket(url, token) {
    const origin = (process.env.PANEL_URL || "").replace(/\/$/, "");
    const ws = new WebSocket(url, { headers: { "Origin": origin } });
    this._ws = ws;

    ws.on("open", () => {
      ws.send(JSON.stringify({ event: "auth", args: [ token ] }));
    });

    ws.on("message", raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this._handleMessage(msg);
    });

    ws.on("error", err => {
      msgLog.error(`[PteroWS:${this._serverId}] error: ${err.message}`);
      this.emit("error", err);
    });

    ws.on("close", code => {
      msgLog.log(`[PteroWS:${this._serverId}] closed (${code})`);
      if (!this._closed) {
        this._reconnect();
      }
    });
  }

  _handleMessage(msg) {
    switch (msg.event) {
    case "auth success":
      msgLog.debugExtended(`[PteroWS:${this._serverId}] auth success`);
      break;

    case "stats": {
      let parsed;
      try { parsed = JSON.parse(msg.args[0]); } catch { return; }
      this.emit("stats", {
        attributes: {
          current_state: parsed.state,
          is_suspended: false,
          resources: {
            cpu_absolute: parsed.cpu_absolute,
            memory_bytes: parsed.memory_bytes,
            disk_bytes: parsed.disk_bytes
          }
        }
      });
      break;
    }

    case "status":
      this.emit("powerStateChange", msg.args[0]);
      break;

    case "console output":
      this.emit("consoleLine", msg.args[0]);
      break;

    case "token expiring":
      this._refreshToken();
      break;

    case "token expired":
      if (this._ws) {
        this._ws.removeAllListeners();
        this._ws.terminate();
        this._ws = null;
      }
      this._reconnect();
      break;
    }
  }

  async _refreshToken() {
    try {
      const { token } = await this._fetchToken();
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ event: "auth", args: [ token ] }));
        msgLog.debugExtended(`[PteroWS:${this._serverId}] token refreshed`);
      }
    } catch (err) {
      msgLog.error(`[PteroWS:${this._serverId}] token refresh failed: ${err.message}`);
      this.emit("error", err);
    }
  }

  sendCommand(command) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ event: "send command", args: [ command ] }));
    }
  }

  async _reconnect() {
    if (this._closed || this._reconnecting) return;
    this._reconnecting = true;
    msgLog.log(`[PteroWS:${this._serverId}] reconnecting in ${RECONNECT_DELAY_MS}ms`);
    await new Promise(r => setTimeout(r, RECONNECT_DELAY_MS));
    this._reconnecting = false;
    if (this._closed) return;
    try {
      await this.connect();
    } catch (err) {
      msgLog.error(`[PteroWS:${this._serverId}] reconnect failed: ${err.message}`);
      this.emit("error", err);
      this.emit("close");
    }
  }
}

module.exports = { PterodactylWebSocket };
