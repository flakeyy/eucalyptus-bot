jest.mock("node:dns", () => ({
  promises: {
    lookup: jest.fn()
  }
}));

const dns = require("node:dns").promises;
const { validateExternalUrl, isPrivateIPv4, isPrivateIPv6 } = require("../utility/url_validation.js");

describe("isPrivateIPv4", () => {
  test.each([
    [ "10.0.0.1", true ],
    [ "10.255.255.255", true ],
    [ "172.16.0.1", true ],
    [ "172.31.255.255", true ],
    [ "172.32.0.1", false ],
    [ "172.15.0.1", false ],
    [ "192.168.1.1", true ],
    [ "127.0.0.1", true ],
    [ "169.254.169.254", true ],
    [ "100.64.0.1", true ],
    [ "224.0.0.1", true ],
    [ "240.0.0.1", true ],
    [ "0.0.0.0", true ],
    [ "8.8.8.8", false ],
    [ "1.1.1.1", false ],
    [ "203.0.113.42", false ],
    [ "not-an-ip", true ],
    [ "1.2.3", true ]
  ])("isPrivateIPv4(%s) === %s", (ip, expected) => {
    expect(isPrivateIPv4(ip)).toBe(expected);
  });
});

describe("isPrivateIPv6", () => {
  test.each([
    [ "::1", true ],
    [ "::", true ],
    [ "fe80::1", true ],
    [ "fc00::1", true ],
    [ "fd12:3456::1", true ],
    [ "ff02::1", true ],
    [ "::ffff:127.0.0.1", true ],
    [ "::ffff:10.0.0.1", true ],
    [ "::ffff:8.8.8.8", false ],
    [ "2001:4860:4860::8888", false ],
    [ "2606:4700:4700::1111", false ]
  ])("isPrivateIPv6(%s) === %s", (ip, expected) => {
    expect(isPrivateIPv6(ip)).toBe(expected);
  });
});

describe("validateExternalUrl", () => {
  beforeEach(() => {
    dns.lookup.mockReset();
  });

  test("rejects non-https schemes", async () => {
    const result = await validateExternalUrl("http://example.com/");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/protocol/);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  test("rejects file: scheme", async () => {
    const result = await validateExternalUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/protocol/);
  });

  test("rejects malformed URL", async () => {
    const result = await validateExternalUrl("not a url");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid URL");
  });

  test("rejects hostname resolving to loopback", async () => {
    dns.lookup.mockResolvedValue([ { address: "127.0.0.1", family: 4 } ]);
    const result = await validateExternalUrl("https://attacker.example/");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/non-public/);
  });

  test("rejects hostname resolving to AWS metadata IP", async () => {
    dns.lookup.mockResolvedValue([ { address: "169.254.169.254", family: 4 } ]);
    const result = await validateExternalUrl("https://attacker.example/");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/non-public/);
  });

  test("rejects hostname resolving to RFC1918", async () => {
    dns.lookup.mockResolvedValue([ { address: "10.0.0.5", family: 4 } ]);
    const result = await validateExternalUrl("https://attacker.example/");
    expect(result.ok).toBe(false);
  });

  test("rejects when any resolved address is private (mixed IPv4/IPv6)", async () => {
    dns.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "::1", family: 6 }
    ]);
    const result = await validateExternalUrl("https://attacker.example/");
    expect(result.ok).toBe(false);
  });

  test("rejects IPv6 literal loopback URL", async () => {
    dns.lookup.mockResolvedValue([ { address: "::1", family: 6 } ]);
    const result = await validateExternalUrl("https://[::1]/");
    expect(result.ok).toBe(false);
  });

  test("rejects DNS lookup failure", async () => {
    dns.lookup.mockRejectedValue(new Error("ENOTFOUND"));
    const result = await validateExternalUrl("https://does-not-resolve.invalid/");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/DNS lookup failed/);
  });

  test("accepts public hostname", async () => {
    dns.lookup.mockResolvedValue([ { address: "151.101.0.69", family: 4 } ]);
    const result = await validateExternalUrl("https://mediafilez.forgecdn.net/files/123/456/foo.zip");
    expect(result.ok).toBe(true);
  });

  test("accepts public IPv6 address", async () => {
    dns.lookup.mockResolvedValue([ { address: "2606:4700:4700::1111", family: 6 } ]);
    const result = await validateExternalUrl("https://cloudflare-dns.com/");
    expect(result.ok).toBe(true);
  });
});
