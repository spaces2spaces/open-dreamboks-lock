import { describe, it, expect } from "vitest";
import { DateTime } from "luxon";
import { mapHourlyWindowToMewsStay } from "../../hourly-mews-window";

const TZ = "Europe/Copenhagen";

const local = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toUTC().toJSDate();
const asLocal = (d: Date) => DateTime.fromJSDate(d, { zone: "utc" }).setZone(TZ).toFormat("yyyy-MM-dd HH:mm");

describe("mapHourlyWindowToMewsStay", () => {
  it("15–18 → night D@15:00 → D+1@10:00", () => {
    const w = mapHourlyWindowToMewsStay(local("2026-07-22T15:00"), local("2026-07-22T18:00"), TZ, "15:00", "10:00");
    expect(w.kind).toBe("night");
    expect(asLocal(w.startUtc)).toBe("2026-07-22 15:00");
    expect(asLocal(w.endUtc)).toBe("2026-07-23 10:00");
  });

  it("17–23 → night anchored on start date", () => {
    const w = mapHourlyWindowToMewsStay(local("2026-07-22T17:00"), local("2026-07-22T23:00"), TZ, "15:00", "10:00");
    expect(w.kind).toBe("night");
    expect(asLocal(w.startUtc)).toBe("2026-07-22 15:00");
    expect(asLocal(w.endUtc)).toBe("2026-07-23 10:00");
  });

  it("23–05 (crosses midnight) → night anchored on START date, not the end date", () => {
    const w = mapHourlyWindowToMewsStay(local("2026-07-22T23:00"), local("2026-07-23T05:00"), TZ, "15:00", "10:00");
    expect(w.kind).toBe("night");
    expect(asLocal(w.startUtc)).toBe("2026-07-22 15:00");
    expect(asLocal(w.endUtc)).toBe("2026-07-23 10:00");
  });

  it("12–18 (overlaps 15:00) → night", () => {
    const w = mapHourlyWindowToMewsStay(local("2026-07-22T12:00"), local("2026-07-22T18:00"), TZ, "15:00", "10:00");
    expect(w.kind).toBe("night");
    expect(asLocal(w.startUtc)).toBe("2026-07-22 15:00");
    expect(asLocal(w.endUtc)).toBe("2026-07-23 10:00");
  });

  it("09–14 (entirely before 15:00) → dayuse start → D@15:00", () => {
    const w = mapHourlyWindowToMewsStay(local("2026-07-22T09:00"), local("2026-07-22T14:00"), TZ, "15:00", "10:00");
    expect(w.kind).toBe("dayuse");
    expect(asLocal(w.startUtc)).toBe("2026-07-22 09:00");
    expect(asLocal(w.endUtc)).toBe("2026-07-22 15:00");
  });

  it("00–05 same day → dayuse ending at that day's 15:00", () => {
    const w = mapHourlyWindowToMewsStay(local("2026-07-22T00:00"), local("2026-07-22T05:00"), TZ, "15:00", "10:00");
    expect(w.kind).toBe("dayuse");
    expect(asLocal(w.startUtc)).toBe("2026-07-22 00:00");
    expect(asLocal(w.endUtc)).toBe("2026-07-22 15:00");
  });

  it("window ending exactly at 15:00 counts as dayuse (endLocal > checkIn is false)", () => {
    const w = mapHourlyWindowToMewsStay(local("2026-07-22T13:00"), local("2026-07-22T15:00"), TZ, "15:00", "10:00");
    expect(w.kind).toBe("dayuse");
  });

  it("DST fall-back date (2026-10-25, 25h day) still lands on local 15:00/10:00", () => {
    const w = mapHourlyWindowToMewsStay(local("2026-10-25T17:00"), local("2026-10-25T21:00"), TZ, "15:00", "10:00");
    expect(w.kind).toBe("night");
    expect(asLocal(w.startUtc)).toBe("2026-10-25 15:00");
    expect(asLocal(w.endUtc)).toBe("2026-10-26 10:00");
  });
});
