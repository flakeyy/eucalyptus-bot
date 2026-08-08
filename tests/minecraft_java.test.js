const {
  parseMcVersionParts,
  compareMcVersions,
  getJavaImageForMCVersion
} = require("../utility/minecraft_java.js");

describe("parseMcVersionParts", () => {
  test("reads major.minor.patch", () => {
    expect(parseMcVersionParts("1.20.5")).toEqual({ major: 1, minor: 20, patch: 5 });
  });

  test("defaults missing patch to 0", () => {
    expect(parseMcVersionParts("26.1")).toEqual({ major: 26, minor: 1, patch: 0 });
  });

  test("returns null for garbage", () => {
    expect(parseMcVersionParts("latest")).toBeNull();
    expect(parseMcVersionParts("")).toBeNull();
  });
});

describe("compareMcVersions", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compareMcVersions(
      { major: 1, minor: 20, patch: 5 },
      { major: 1, minor: 20, patch: 1 }
    )).toBeGreaterThan(0);
    expect(compareMcVersions(
      { major: 1, minor: 7, patch: 10 },
      { major: 1, minor: 8, patch: 0 }
    )).toBeLessThan(0);
  });
});

describe("getJavaImageForMCVersion", () => {
  const config = {
    java_images: {
      "8": "img:8",
      "11": "img:11",
      "17": "img:17",
      "21": "img:21",
      "25": "img:25"
    },
    minecraft_java_map: {
      "26.1": 25,
      "1.20.5": 21,
      "1.20": 17,
      "1.18": 17,
      "1.17": 17,
      "1.16": 11,
      "1.12": 8,
      "1.8": 8
    }
  };

  test("26.1+ uses Java 25", () => {
    expect(getJavaImageForMCVersion("26.1", config)).toBe("img:25");
    expect(getJavaImageForMCVersion("26.2", config)).toBe("img:25");
  });

  test("1.20.5 through 1.21.x use Java 21", () => {
    expect(getJavaImageForMCVersion("1.20.5", config)).toBe("img:21");
    expect(getJavaImageForMCVersion("1.21.11", config)).toBe("img:21");
  });

  test("1.20.0–1.20.4 use Java 17", () => {
    expect(getJavaImageForMCVersion("1.20.1", config)).toBe("img:17");
    expect(getJavaImageForMCVersion("1.20.4", config)).toBe("img:17");
  });

  test("1.16 uses Java 11", () => {
    expect(getJavaImageForMCVersion("1.16.5", config)).toBe("img:11");
  });

  test("versions below 1.8 fall back to Java 8", () => {
    expect(getJavaImageForMCVersion("1.7.10", config)).toBe("img:8");
    expect(getJavaImageForMCVersion("1.6.4", config)).toBe("img:8");
  });

  test("1.8 / 1.12 use Java 8", () => {
    expect(getJavaImageForMCVersion("1.8.9", config)).toBe("img:8");
    expect(getJavaImageForMCVersion("1.12.2", config)).toBe("img:8");
  });
});
