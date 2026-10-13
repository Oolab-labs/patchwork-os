import { describe, expect, it } from "vitest";
import {
  effectiveScheduleTimezone,
  type PatchworkConfig,
  scheduleTimezoneSource,
} from "../patchworkConfig.js";

/** Only the `recipes` block matters here. */
const cfg = (c: object) => c as PatchworkConfig;

describe("scheduleTimezoneSource", () => {
  it("is 'default' when no zone was ever chosen", () => {
    expect(scheduleTimezoneSource(cfg({}))).toBe("default");
    expect(scheduleTimezoneSource(cfg({ recipes: {} }))).toBe("default");
  });

  it("treats an empty string as unset, like effectiveScheduleTimezone", () => {
    const empty = cfg({ recipes: { timezone: "" } });
    expect(scheduleTimezoneSource(empty)).toBe("default");
    expect(effectiveScheduleTimezone(empty)).toBe("UTC");
  });

  it("is 'config' for an explicit choice, including an explicit UTC", () => {
    expect(scheduleTimezoneSource(cfg({ recipes: { timezone: "UTC" } }))).toBe(
      "config",
    );
    expect(
      scheduleTimezoneSource(cfg({ recipes: { timezone: "Europe/Lisbon" } })),
    ).toBe("config");
  });
});
