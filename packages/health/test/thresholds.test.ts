import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, resolveThresholds } from "../src";

describe("thresholds", () => {
  it("freezes the defaults", () => {
    expect(Object.isFrozen(DEFAULT_THRESHOLDS)).toBe(true);
  });

  it("merges partial overrides without touching the defaults", () => {
    const merged = resolveThresholds({ stallMinutes: 1 });
    expect(merged.stallMinutes).toBe(1);
    expect(merged.zombieMinutes).toBe(DEFAULT_THRESHOLDS.zombieMinutes);
    expect(DEFAULT_THRESHOLDS.stallMinutes).toBe(10);
  });

  it("ignores undefined override values", () => {
    expect(resolveThresholds({ stallMinutes: undefined }).stallMinutes).toBe(10);
  });
});
