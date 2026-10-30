import { describe, expect, it } from "vitest";
import type { Finding } from "./analyze";
import { describeGrowth, KILL_MS, type Sample } from "./client";

const finding = (severity: Finding["severity"]): Finding => ({
  severity,
  rule: "nested-quantifier",
  title: "",
  detail: "",
  spans: [],
  prefix: "",
  pump: "a",
  suffix: "b",
  exploitable: true,
});

const sample = (n: number, ms: number, killed = false): Sample => ({ n, length: n, ms, killed });

describe("describeGrowth", () => {
  it("confirms a killed run even when earlier timings look flat", () => {
    const samples = [sample(20, 1), sample(22, 1.1), sample(24, KILL_MS, true)];
    expect(describeGrowth(finding("exponential"), samples, false)?.confirmed).toBe(true);
    expect(describeGrowth(finding("polynomial"), samples, false)?.confirmed).toBe(true);
  });

  it("fits exponential growth across several samples", () => {
    const samples = [10, 12, 14, 16].map((n) => sample(n, 2 ** (n - 8)));
    const g = describeGrowth(finding("exponential"), samples, false);
    expect(g?.confirmed).toBe(true);
    expect(g?.text).toContain("×2.00");
  });

  it("fits polynomial growth", () => {
    const samples = [1000, 2000, 4000].map((n) => sample(n, (n / 100) ** 2));
    expect(describeGrowth(finding("polynomial"), samples, false)?.text).toContain("O(n^2.0)");
  });

  it("doesn't blame the engine when nothing slowed down", () => {
    const g = describeGrowth(finding("polynomial"), [sample(1000, 0.1)], false);
    expect(g?.confirmed).toBe(false);
    expect(g?.text).toMatch(/false alarm/);
  });

  it("waits for data while a run is in progress", () => {
    expect(describeGrowth(finding("polynomial"), [sample(1000, 0.1)], true)).toBeNull();
  });
});
