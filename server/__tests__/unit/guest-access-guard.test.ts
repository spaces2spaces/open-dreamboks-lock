/**
 * Guest access guard: per-reservation lockout for form-grade identifiers,
 * never for link-grade (UUID) ones, plus the tenant-wide brute-force alert.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const alertSpy = vi.fn(async () => true);
vi.mock("../../ops-alert", () => ({ sendOpsAlert: (...args: unknown[]) => alertSpy(...(args as [])) }));

import { GuestAccessGuard, LOCK_AFTER, LOCK_DURATION_MS, ALERT_WARN_AT, ALERT_CRITICAL_AT, ALERT_WINDOW_MS } from "../../guest-access-guard";
import { isLinkGradeIdentifier } from "@shared/guest-identifier";
import { buildBoardingPassUrl } from "@shared/boarding-pass-url";

const T = "tenant-a";
const UUID = "3f2b9c1e-7d4a-4b8e-9a1f-0c2d3e4f5a6b";
const storage = { getSetting: vi.fn(async () => null), setSetting: vi.fn(async () => {}), createLog: vi.fn(async () => {}) };

function makeGuard() {
  let now = 1_000_000;
  const guard = new GuestAccessGuard(() => now);
  return { guard, advance: (ms: number) => { now += ms; } };
}

beforeEach(() => alertSpy.mockClear());

describe("identifier grades", () => {
  it("recognises the reservation UUID as link-grade and everything else as form-grade", () => {
    expect(isLinkGradeIdentifier(UUID)).toBe(true);
    expect(isLinkGradeIdentifier(UUID.toUpperCase())).toBe(true);
    expect(isLinkGradeIdentifier("73468")).toBe(false);
    expect(isLinkGradeIdentifier("4321987650")).toBe(false);
    expect(isLinkGradeIdentifier("")).toBe(false);
    expect(isLinkGradeIdentifier(null)).toBe(false);
  });
  it("builds guest links with the UUID, never the booking number", () => {
    const url = buildBoardingPassUrl("https://lock.example.com/", { id: UUID, lastName: "Ø Hansen" }, "my-hotel");
    expect(url).toBe(`https://lock.example.com/boarding-pass?res=${UUID}&name=%C3%98%20Hansen&hotel=my-hotel`);
    expect(url).not.toContain("73468");
  });
});

describe("per-reservation lockout", () => {
  it("locks a form-grade identifier after LOCK_AFTER failures, for LOCK_DURATION_MS", async () => {
    const { guard, advance } = makeGuard();
    for (let i = 0; i < LOCK_AFTER - 1; i++) {
      expect((await guard.recordFailure(T, "73468", "1.1.1.1")).locked).toBe(false);
      expect(guard.lockedFor(T, "73468")).toBe(0);
    }
    expect((await guard.recordFailure(T, "73468", "1.1.1.1")).locked).toBe(true);
    expect(guard.lockedFor(T, "73468")).toBe(LOCK_DURATION_MS);
    advance(LOCK_DURATION_MS - 1);
    expect(guard.lockedFor(T, "73468")).toBe(1);
    advance(1);
    expect(guard.lockedFor(T, "73468")).toBe(0);
  });
  it("is keyed per tenant and per identifier (case-insensitive), so other guests are unaffected", async () => {
    const { guard } = makeGuard();
    for (let i = 0; i < LOCK_AFTER; i++) await guard.recordFailure(T, "73468", "1.1.1.1");
    expect(guard.lockedFor(T, " 73468 ")).toBeGreaterThan(0);
    expect(guard.lockedFor(T, "73469")).toBe(0);
    expect(guard.lockedFor("tenant-b", "73468")).toBe(0);
  });
  it("never locks a link-grade identifier", async () => {
    const { guard } = makeGuard();
    for (let i = 0; i < LOCK_AFTER * 3; i++) expect((await guard.recordFailure(T, UUID, "1.1.1.1")).locked).toBe(false);
    expect(guard.lockedFor(T, UUID)).toBe(0);
  });
  it("a successful lookup clears the streak", async () => {
    const { guard } = makeGuard();
    for (let i = 0; i < LOCK_AFTER - 1; i++) await guard.recordFailure(T, "73468", "1.1.1.1");
    guard.recordSuccess(T, "73468");
    for (let i = 0; i < LOCK_AFTER - 1; i++) expect((await guard.recordFailure(T, "73468", "1.1.1.1")).locked).toBe(false);
  });
});

describe("tenant-wide brute-force alert", () => {
  it("stays silent below the warning threshold and warns once it is crossed", async () => {
    const { guard } = makeGuard();
    for (let i = 0; i < ALERT_WARN_AT - 1; i++) await guard.recordProbe(T, `10.0.0.${i % 3}`, storage);
    expect(alertSpy).not.toHaveBeenCalled();
    await guard.recordProbe(T, "10.0.0.9", storage);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [, key, severity, message, detail] = alertSpy.mock.calls[0] as unknown as [unknown, string, string, string, string];
    expect(key).toBe("public-lookup-bruteforce");
    expect(severity).toBe("warning");
    expect(message).toContain(`${ALERT_WARN_AT}+`);
    expect(detail).toContain("Distinct IPs: 4");
  });
  it("escalates to critical at the critical threshold, with a stable bucketed message", async () => {
    const { guard } = makeGuard();
    for (let i = 0; i < ALERT_CRITICAL_AT + 5; i++) await guard.recordFailure(T, String(70000 + i), "10.0.0.1", storage);
    const severities = alertSpy.mock.calls.map(c => (c as unknown as [unknown, string, string])[2]);
    expect(severities.filter(s => s === "critical").length).toBeGreaterThan(0);
    const criticalMessages = new Set(alertSpy.mock.calls.filter(c => (c as unknown as [unknown, string, string])[2] === "critical").map(c => (c as unknown as [unknown, string, string, string])[3]));
    expect(criticalMessages.size).toBe(1); // bucketed — does not change as the count climbs
  });
  it("forgets failures older than the alert window", async () => {
    const { guard, advance } = makeGuard();
    for (let i = 0; i < ALERT_WARN_AT - 1; i++) await guard.recordProbe(T, "10.0.0.1", storage);
    advance(ALERT_WINDOW_MS);
    await guard.recordProbe(T, "10.0.0.1", storage);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
