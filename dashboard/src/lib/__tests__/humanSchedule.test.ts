import { describe, expect, it } from "vitest";
import { describeNextRun, humanizeSchedule } from "../humanSchedule";

// A fixed clock: Wed 2026-07-01 06:00:00 local.
const NOW = new Date(2026, 6, 1, 6, 0, 0, 0);

describe("humanizeSchedule", () => {
  it("empty → runs-only-when-started", () => {
    expect(humanizeSchedule("", NOW).text).toMatch(/only when you start it/i);
    expect(humanizeSchedule(undefined, NOW).humanized).toBe(true);
  });

  it("daily cron at a time", () => {
    const r = humanizeSchedule("0 7 * * *", NOW);
    expect(r.text).toBe("Every day at 7:00");
    expect(r.humanized).toBe(true);
    // 07:00 today is 1h out from 06:00.
    expect(r.nextRunAt).toBe(new Date(2026, 6, 1, 7, 0, 0, 0).getTime());
  });

  it("daily cron whose time already passed today rolls to tomorrow", () => {
    const r = humanizeSchedule("30 5 * * *", NOW);
    expect(r.text).toBe("Every day at 5:30");
    expect(r.nextRunAt).toBe(new Date(2026, 6, 2, 5, 30, 0, 0).getTime());
  });

  it("every N minutes", () => {
    const r = humanizeSchedule("*/15 * * * *", NOW);
    expect(r.text).toBe("Every 15 minutes");
    expect(r.nextRunAt).toBe(NOW.getTime() + 15 * 60_000);
  });

  it("hourly at a minute", () => {
    expect(humanizeSchedule("0 * * * *", NOW).text).toBe("Every hour, on the hour");
    expect(humanizeSchedule("20 * * * *", NOW).text).toBe("Every hour at :20");
  });

  it("weekly on a weekday", () => {
    // dow 1 = Monday. From Wed, next Monday.
    const r = humanizeSchedule("0 9 * * 1", NOW);
    expect(r.text).toBe("Every Monday at 9:00");
    expect(new Date(r.nextRunAt as number).getDay()).toBe(1);
  });

  it("monthly on a day-of-month", () => {
    expect(humanizeSchedule("0 8 15 * *", NOW).text).toBe(
      "On the 15th of every month at 8:00",
    );
  });

  it("@every macros", () => {
    expect(humanizeSchedule("@every 30s", NOW).text).toBe("Every 30 seconds");
    expect(humanizeSchedule("@every 1h", NOW).text).toBe("Every 1 hour");
    const r = humanizeSchedule("@every 30s", NOW);
    expect(r.nextRunAt).toBe(NOW.getTime() + 30_000);
  });

  it("@daily / @hourly macros", () => {
    expect(humanizeSchedule("@daily", NOW).text).toBe("Every day at midnight");
    expect(humanizeSchedule("@hourly", NOW).text).toBe("Every hour");
  });

  it("unrecognized cron falls back to raw, humanized=false", () => {
    const r = humanizeSchedule("5 4 * 3 2", NOW);
    expect(r.humanized).toBe(false);
    expect(r.text).toBe("5 4 * 3 2");
    expect(r.raw).toBe("5 4 * 3 2");
  });
});

describe("describeNextRun", () => {
  it("minutes / hours / days buckets", () => {
    expect(describeNextRun(NOW.getTime() + 5 * 60_000, NOW)).toBe("next in 5 minutes");
    expect(describeNextRun(NOW.getTime() + 14 * 3_600_000, NOW)).toBe("next in 14 hours");
    expect(describeNextRun(NOW.getTime() + 3 * 86_400_000, NOW)).toBe("next in 3 days");
  });
  it("past / missing", () => {
    expect(describeNextRun(NOW.getTime() - 1000, NOW)).toBe("any moment now");
    expect(describeNextRun(undefined, NOW)).toBeNull();
  });
});
