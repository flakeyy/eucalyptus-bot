// Plain-object Discord interaction factories for tests.
// No Jest mocks of project modules here — just jest.fn() stubs.

function makeReplyInteraction({
  user = { id: "discord123", username: "testuser" },
  replied = false,
  deferred = false
} = {}) {
  return {
    reply: jest.fn().mockResolvedValue(undefined),
    followUp: jest.fn().mockResolvedValue(undefined),
    user,
    replied,
    deferred
  };
}

function makeDeferredInteraction({
  user = { id: "discord123", username: "testuser" },
  apiKey = "new-valid-key"
} = {}) {
  return {
    deferReply: jest.fn(),
    editReply: jest.fn(),
    user,
    options: {
      getString: jest.fn().mockReturnValue(apiKey)
    }
  };
}

function makeAdminInteraction({
  group = null,
  sub,
  discordUser = { id: "target123", username: "target" },
  user = { id: "admin999", username: "admin" },
  extraOptions = {}
} = {}) {
  return {
    deferReply: jest.fn(),
    editReply: jest.fn(),
    fetchReply: jest.fn().mockResolvedValue({
      createMessageComponentCollector: jest.fn().mockReturnValue({
        on: jest.fn(),
        stop: jest.fn()
      })
    }),
    user,
    options: {
      getSubcommandGroup: jest.fn(() => group),
      getSubcommand: jest.fn(() => sub),
      getUser: jest.fn(() => discordUser),
      getString: jest.fn(),
      getInteger: jest.fn(() => null),
      ...extraOptions
    }
  };
}

module.exports = {
  makeReplyInteraction,
  makeDeferredInteraction,
  makeAdminInteraction
};
