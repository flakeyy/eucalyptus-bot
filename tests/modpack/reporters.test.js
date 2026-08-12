"use strict";

const { MessageFlags } = require("discord.js");
const { COLORS } = require("../../utility/constants.js");
const { DiscordReporter, CollectingReporter } = require("../../utility/modpack/reporters.js");

describe("CollectingReporter", () => {
  test("records progress and done events", async () => {
    const r = new CollectingReporter();
    await r.progress("hello", { stage: "download", pct: 10 });
    await r.done("finished");
    expect(r.events).toHaveLength(2);
    expect(r.events[0]).toMatchObject({ stage: "download", message: "hello", pct: 10 });
    expect(r.events[1]).toMatchObject({ stage: "done", message: "finished" });
  });

  test("updateProgress shim ignores the interaction arg", async () => {
    const r = new CollectingReporter();
    await r.updateProgress({ editReply: jest.fn() }, "msg");
    expect(r.events[0].message).toBe("msg");
  });
});

describe("DiscordReporter", () => {
  test("progress edits with Installing prefix and PRIMARY accent", async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const r = new DiscordReporter({ editReply });
    await r.progress("Downloading...");
    expect(editReply).toHaveBeenCalledTimes(1);
    const arg = editReply.mock.calls[0][0];
    expect(arg.flags).toBe(MessageFlags.IsComponentsV2);
    const json = JSON.stringify(arg.components[0]);
    expect(json).toContain("Installing Modpack");
    expect(json).toContain("Downloading...");
    expect(json).toContain(String(COLORS.PRIMARY));
  });

  test("done edits without Installing prefix and SUCCESS accent", async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const r = new DiscordReporter({ editReply });
    await r.done("**Installation Complete**");
    const json = JSON.stringify(editReply.mock.calls[0][0].components[0]);
    expect(json).toContain("Installation Complete");
    expect(json).not.toContain("Installing Modpack");
    expect(json).toContain(String(COLORS.SUCCESS));
  });

  test("editReply failures are swallowed", async () => {
    const editReply = jest.fn().mockRejectedValue(new Error("token expired"));
    const r = new DiscordReporter({ editReply });
    await expect(r.progress("x")).resolves.toBeUndefined();
  });

  test("hands off to channel after TOKEN_HANDOFF_MS", async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const channelMessage = { edit: jest.fn().mockResolvedValue(undefined) };
    const channel = { send: jest.fn().mockResolvedValue(channelMessage) };
    const r = new DiscordReporter({ editReply }, { channel, handoffMs: 100, throttleMs: 0 });
    r._startedAt = Date.now() - 200; // already past handoff threshold
    await r.progress("late");
    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(editReply.mock.calls.at(-1))).toContain("Continuing in the channel");
    await r.progress("after");
    expect(channelMessage.edit).toHaveBeenCalled();
  });

  test("done() past the window reaches the channel, not a dead token", async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const channelMessage = { edit: jest.fn().mockResolvedValue(undefined) };
    const channel = { send: jest.fn().mockResolvedValue(channelMessage) };
    const r = new DiscordReporter({ editReply }, { channel, handoffMs: 100, throttleMs: 0 });
    // The job crossed the handoff window without ever emitting a progress edit,
    // so done() is the first call past it — the exact case the guard used to miss.
    r._startedAt = Date.now() - 200;

    await r.done("**Installation Complete**");

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(channel.send.mock.calls[0][0])).toContain("Installation Complete");
  });

  test("done() before the window still edits the original reply", async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const channel = { send: jest.fn() };
    const r = new DiscordReporter({ editReply }, { channel, handoffMs: 100_000, throttleMs: 0 });

    await r.done("**Installation Complete**");

    expect(channel.send).not.toHaveBeenCalled();
    expect(JSON.stringify(editReply.mock.calls.at(-1))).toContain("Installation Complete");
  });

  test("done() after an earlier handoff edits the channel message", async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const channelMessage = { edit: jest.fn().mockResolvedValue(undefined) };
    const channel = { send: jest.fn().mockResolvedValue(channelMessage) };
    const r = new DiscordReporter({ editReply }, { channel, handoffMs: 100, throttleMs: 0 });
    r._startedAt = Date.now() - 200;
    await r.progress("late");

    await r.done("**Installation Complete**");

    expect(channel.send).toHaveBeenCalledTimes(1); // no second channel message
    expect(JSON.stringify(channelMessage.edit.mock.calls.at(-1))).toContain("Installation Complete");
  });

  test("opts.startedAt anchors the handoff clock to the original interaction", async () => {
    const editReply = jest.fn().mockResolvedValue(undefined);
    const channelMessage = { edit: jest.fn().mockResolvedValue(undefined) };
    const channel = { send: jest.fn().mockResolvedValue(channelMessage) };
    // The user sat on the wizard for a while before confirming: the token is
    // already 200ms old at construction even though the job just started.
    const r = new DiscordReporter({ editReply }, {
      channel, handoffMs: 100, throttleMs: 0, startedAt: Date.now() - 200
    });

    await r.progress("first update");

    expect(channel.send).toHaveBeenCalledTimes(1);
  });
});
