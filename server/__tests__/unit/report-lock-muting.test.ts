/**
 * Report lock muting (`report_ignored_locks` setting): owner can silence
 * specific locks (e.g. a parking door with a chronically dead gateway) in the
 * arrival report — gaps, offline lines AND escalation — without touching the
 * repair machinery.
 */
import { describe, it, expect } from "vitest";
import { applyReportLockMuting } from "../../lock-arrival-report";

const input = {
  gaps: [
    { lockName: "Main Entrance", code: "1111" },
    { lockName: "Parking 6", code: "2222" },
  ],
  offlineDoors: ["Parking 6", "Bike Shed"],
  offlineDoorsDetailed: [
    { lockName: "Parking 6", ttlockId: "tt-p6" },
    { lockName: "Bike Shed", ttlockId: "tt-bike" },
  ],
};

describe("applyReportLockMuting", () => {
  it("mutes listed locks across gaps, offline lines and escalation details", () => {
    const result = applyReportLockMuting(input, "Parking 6");

    expect(result.gaps.map(g => g.lockName)).toEqual(["Main Entrance"]);
    expect(result.offlineDoors).toEqual(["Bike Shed"]);
    expect(result.offlineDoorsDetailed.map(d => d.lockName)).toEqual(["Bike Shed"]);
  });

  it("is case-insensitive, trims whitespace and supports several names", () => {
    const result = applyReportLockMuting(input, " parking 6 ; BIKE SHED ");

    expect(result.gaps.map(g => g.lockName)).toEqual(["Main Entrance"]);
    expect(result.offlineDoors).toEqual([]);
    expect(result.offlineDoorsDetailed).toEqual([]);
  });

  it("empty/absent setting mutes nothing", () => {
    expect(applyReportLockMuting(input, "")).toEqual(input);
    expect(applyReportLockMuting(input, null)).toEqual(input);
    expect(applyReportLockMuting(input, undefined)).toEqual(input);
  });

  it("does not mute locks that merely share a prefix", () => {
    const result = applyReportLockMuting(input, "Parking");
    expect(result.offlineDoors).toContain("Parking 6");
  });
});
