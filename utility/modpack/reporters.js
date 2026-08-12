"use strict";

const { ContainerBuilder, MessageFlags } = require("discord.js");
const { COLORS, WS_THROTTLE_MS } = require("../constants.js");

// Interaction tokens die at 15 minutes. Past this elapsed time, DiscordReporter
// hands progress off to a bot-owned channel message that stays editable.
const TOKEN_HANDOFF_MS = 11 * 60 * 1000;

/**
 * Progress/final-status sink for the install job. Discord types stay here so
 * utility/modpack/job.js never imports discord.js.
 */
class DiscordReporter {
  /**
   * @param {object} replyTarget  Interaction (or stub) with editReply()
   * @param {object} [opts]
   * @param {object} [opts.channel]  Discord channel for late handoff
   * @param {number} [opts.throttleMs]
   * @param {number} [opts.handoffMs]
   * @param {number} [opts.startedAt]  Interaction createdTimestamp. Discord kills
   *   the token 15 minutes after the *original* interaction, not after the install
   *   was confirmed — a user can spend minutes in the wizard first, so defaulting
   *   this to construction time would let the handoff fire after the token is dead.
   */
  constructor(replyTarget, opts = {}) {
    this._reply = replyTarget;
    this._channel = opts.channel ?? replyTarget?.channel ?? null;
    this._throttleMs = opts.throttleMs ?? WS_THROTTLE_MS;
    this._handoffMs = opts.handoffMs ?? TOKEN_HANDOFF_MS;
    this._startedAt = opts.startedAt ?? Date.now();
    this._lastEditAt = 0;
    this._pending = null;
    this._pendingTimer = null;
    this._channelMessage = null;
    this._handedOff = false;
    this.events = [];
  }

  async progress(message, meta = {}) {
    this.events.push({ stage: meta.stage ?? null, message, pct: meta.pct ?? null, at: Date.now() });
    return this._scheduleEdit(`**Installing Modpack**\n\n${message}`, COLORS.PRIMARY);
  }

  async done(message, { accent = COLORS.SUCCESS } = {}) {
    this.events.push({ stage: "done", message, pct: null, at: Date.now() });
    this._flushPending();
    return this._editNow(message, accent, { isDone: true });
  }

  /** Back-compat shim for installFilePlan/installArchiveBuffer ctx.updateProgress(i, msg). */
  updateProgress(_i, message) {
    return this.progress(message);
  }

  _flushPending() {
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
    this._pending = null;
  }

  async _scheduleEdit(message, accent) {
    const now = Date.now();
    const since = now - this._lastEditAt;
    if (since >= this._throttleMs || this._lastEditAt === 0) {
      return this._editNow(message, accent);
    }
    this._pending = { message, accent };
    if (!this._pendingTimer) {
      this._pendingTimer = setTimeout(() => {
        this._pendingTimer = null;
        const p = this._pending;
        this._pending = null;
        if (p) this._editNow(p.message, p.accent).catch(() => {});
      }, this._throttleMs - since);
      if (typeof this._pendingTimer.unref === "function") this._pendingTimer.unref();
    }
  }

  async _editNow(message, accent, { isDone = false } = {}) {
    this._lastEditAt = Date.now();
    const container = new ContainerBuilder()
      .setAccentColor(accent)
      .addTextDisplayComponents(text => text.setContent(message));

    // done() takes this path too: a job that finishes past the window without
    // ever having crossed it during a progress edit would otherwise send its
    // final result to a dead token, where .catch() swallows the failure — the
    // frozen-message outcome the handoff exists to prevent.
    const elapsed = Date.now() - this._startedAt;
    if (!this._handedOff && elapsed >= this._handoffMs && this._channel?.send) {
      const pointer = isDone
        ? "**Installing Modpack**\n\nFinished — the result is in the channel below."
        : "**Installing Modpack**\n\nContinuing in the channel below — this install is taking longer than Discord allows for ephemeral updates.";
      try {
        await this._reply.editReply({
          components: [ new ContainerBuilder()
            .setAccentColor(COLORS.PRIMARY)
            .addTextDisplayComponents(text => text.setContent(pointer)) ],
          flags: MessageFlags.IsComponentsV2
        }).catch(() => {});
        this._channelMessage = await this._channel.send({
          components: [ container ],
          flags: MessageFlags.IsComponentsV2
        });
        this._handedOff = true;
        return;
      } catch {
        // Fall through to ephemeral edit if channel send fails.
      }
    }

    if (this._handedOff && this._channelMessage?.edit) {
      await this._channelMessage.edit({
        components: [ container ],
        flags: MessageFlags.IsComponentsV2
      }).catch(() => {});
      return;
    }

    await this._reply.editReply({
      components: [ container ],
      flags: MessageFlags.IsComponentsV2
    }).catch(() => {});
  }
}

/**
 * Records progress events for Jest and smoke scripts — no Discord I/O.
 */
class CollectingReporter {
  constructor() {
    this.events = [];
  }

  async progress(message, meta = {}) {
    this.events.push({ stage: meta.stage ?? null, message, pct: meta.pct ?? null, at: Date.now() });
  }

  async done(message) {
    this.events.push({ stage: "done", message, pct: null, at: Date.now() });
  }

  updateProgress(_i, message) {
    return this.progress(message);
  }
}

module.exports = {
  DiscordReporter,
  CollectingReporter,
  TOKEN_HANDOFF_MS,
  WS_THROTTLE_MS
};
