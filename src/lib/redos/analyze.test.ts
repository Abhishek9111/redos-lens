import { describe, expect, it } from "vitest";
import { analyze } from "./analyze";
import { parseInput } from "./format";

const verdict = (source: string, flags = "") => analyze(source, flags).verdict;

/** Run the finding's attack string, with a size that's fast for safe regexes. */
function attack(source: string, flags = "", n = 2000) {
  const f = analyze(source, flags).findings[0];
  return f.prefix + f.pump.repeat(n) + f.suffix;
}

describe("exponential patterns", () => {
  it.each([
    ["^(a+)+$"],
    ["^(\\w+\\s?)*$"],
    ["(x+x+)+y"],
    ["^(a|a)*$"],
    ["^(\\d|\\w)+$"],
    ["^(a|aa)+$"],
    ["^(.*)*$"],
    ["^([a-zA-Z0-9_\\.\\-])+\\@(([a-zA-Z0-9\\-])+\\.)+([a-zA-Z0-9]{2,4})+$"],
    ["^(?=(a+)+$)"],
  ])("flags %s", (source) => {
    expect(verdict(source)).toBe("exponential");
  });

  it.each([["^(я+)+$"], ["^([а-я]+)+$"], ["^(ñ|ñ)+$"]])("sees non-ASCII loop %s", (source) => {
    expect(verdict(source)).toBe("exponential");
  });

  it.each([["^(?:\\p{Script=Cyrillic}+)+$"], ["^(?:😀+)+$"], ["^(😀|😀)+$"]])(
    "sees unicode-mode loop %s",
    (source) => {
      expect(verdict(source, "u")).toBe("exponential");
    },
  );

  it.each([["^(a|b|ab)*$"], ["^(aab|aa|b)*$"], ["^(foo|bar|foobar)*$"]])(
    "sees one iteration vs two in %s",
    (source) => {
      expect(verdict(source)).toBe("exponential");
    },
  );

  it.each([
    ["^((abc)+)+$", "abc"],
    ["^((ab)+)+$", "ab"],
    ["^((foo)+)+$", "foo"],
  ])("finds the multi-character pump in %s", (source, pump) => {
    const f = analyze(source, "").findings[0];
    expect(f.severity).toBe("exponential");
    expect(f.pump).toBe(pump);
  });

  it("keeps searching past a pump that can't reach the loop", () => {
    expect(verdict("^(?=.*\\d)(\\w+)+$")).toBe("exponential");
  });

  it("handles named groups in a loop body", () => {
    expect(verdict("^(?<x>a+)+$")).toBe("exponential");
  });
});

describe("polynomial patterns", () => {
  it.each([
    ["\\s+$", 2],
    ["^\\d+\\d+$", 2],
    [".*.*=", 3],
    ["a|b+$", 2],
    ["^a|\\s+$", 2],
    ["^\\d+\\d{2}\\d+$", 2],
  ])("flags %s as degree %i", (source, degree) => {
    const r = analyze(source, "");
    expect(r.verdict).toBe("polynomial");
    expect(r.findings[0].degree).toBe(degree);
  });

  it.each([["^(a+)?a+$"], ["^(?:a+|b)a+$"], ["(?:\\s+|x)$"], ["(\\s+)$"]])(
    "sees loops inside groups in %s",
    (source) => {
      expect(verdict(source)).toBe("polynomial");
    },
  );

  it("doesn't repeat a loop already reported as exponential", () => {
    expect(analyze("^(a+)+$", "").findings).toHaveLength(1);
    expect(analyze("(a+)+$", "").findings).toHaveLength(1);
  });
});

describe("safe patterns", () => {
  it.each([
    ["^[a-z0-9-]+$"],
    ["^[a-z0-9]+(?:-[a-z0-9]+)*$"],
    ["^(ab)*$"],
    ["^(a+b)*$"],
    ["^\\d+\\.\\d+$"],
    ["^(?:a|b)*c$"],
    ["^(abc|abd)+$"],
    ["\\bfoo"],
    ["^(a|b|)*$"],
    ["(^a+)+$"],
  ])("clears %s", (source) => {
    expect(verdict(source)).toBe("safe");
  });

  it("clears a word list whose \\b blocks splitting", () => {
    expect(verdict("^(\\b\\w+\\b\\s*)*$")).toBe("safe");
  });

  it("doesn't guess at loops containing backreferences", () => {
    const r = analyze("^(?:(a)\\1)+$", "");
    expect(r.verdict).toBe("safe");
    expect(r.notes.join()).toMatch(/backreferences/);
  });

  it("marks a match that can't fail as not exploitable", () => {
    const r = analyze("(a+)+", "");
    expect(r.verdict).toBe("safe");
    expect(r.findings[0].blocked).toBe("always-matches");
  });
});

describe("reachability", () => {
  it("reports a loop the input can't reach as possible, not exploitable", () => {
    const r = analyze("^(?!a)(a+)+$", "");
    expect(r.verdict).toBe("possible");
    expect(r.findings[0].blocked).toBe("unreached");
  });

  it("builds a prefix through a backreference", () => {
    const f = analyze("^(x)\\1(a+)+$", "").findings[0];
    expect(f.prefix).toBe("xx");
    expect(f.exploitable).toBe(true);
  });

  it("survives groups that refer to each other", () => {
    expect(() => analyze("(\\2)(\\1)(a+)+$", "")).not.toThrow();
  });
});

describe("attack strings", () => {
  it.each([["\\s+$"], ["^\\d+\\d+$"]])("really fails to match for %s", (source) => {
    expect(new RegExp(source).test(attack(source))).toBe(false);
  });
});

describe("input handling", () => {
  it("rejects invalid patterns and flags", () => {
    expect(verdict("(a")).toBe("invalid");
    expect(verdict("a", "gg")).toBe("invalid");
    expect(verdict("a", "uv")).toBe("invalid");
  });

  it("ignores the g flag and honours y", () => {
    expect(verdict("^(\\w+)*$", "gi")).toBe("exponential");
    expect(verdict("\\s+$", "y")).toBe("safe");
  });

  it("parses regex literals", () => {
    expect(parseInput("/a\\/b/gi")).toEqual({ source: "a\\/b", flags: "gi" });
    expect(parseInput("/[/]/")).toEqual({ source: "[/]", flags: "" });
  });

  it("doesn't mistake a slash-wrapped path for a literal", () => {
    expect(parseInput("/usr/bin/")).toBeNull();
    expect(parseInput("//")).toBeNull();
    expect(parseInput("abc")).toBeNull();
  });
});

describe("speed", () => {
  it("stays fast on a long alternation", () => {
    const words = Array.from({ length: 800 }, (_, i) => `word${i.toString(36)}`).join("|");
    const start = performance.now();
    analyze(`^(?:${words})$`, "");
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it("doesn't hang on a pattern with many nested loops", () => {
    const start = performance.now();
    analyze("^((((a+)+)+)+)+$", "");
    expect(performance.now() - start).toBeLessThan(1500);
  });
});
