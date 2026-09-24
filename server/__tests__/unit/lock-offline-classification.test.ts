/**
 * Tests for isLockOfflineError — the classifier that keeps a single offline
 * lock (gateway down, TTLock -3034) from breaking the whole PIN procedure.
 *
 * Contract: TRUE only for lock-connectivity conditions (retry later, do NOT
 * treat the guest's PIN as failed). FALSE for real failures (bad params, auth,
 * duplicate) — those must stay loud so genuine problems aren't hidden.
 */

import { describe, it, expect } from "vitest";
import { isLockOfflineError } from "../../ttlock-client";

describe("isLockOfflineError", () => {
  it("returns true for gateway-offline conditions", () => {
    expect(isLockOfflineError("TTLock API error: -3034 - Device not connected to network. Please configure network")).toBe(true);
    expect(isLockOfflineError("-3034")).toBe(true);
    expect(isLockOfflineError("The device is offline")).toBe(true);
    expect(isLockOfflineError("Lock is offline right now")).toBe(true);
    expect(isLockOfflineError("Device NOT Connected To Network")).toBe(true); // case-insensitive
  });

  it("returns false for real (non-connectivity) failures — must stay loud", () => {
    expect(isLockOfflineError("TTLock API error: -3007 - same passcode already exists")).toBe(false);
    expect(isLockOfflineError("Invalid access_token")).toBe(false);
    expect(isLockOfflineError("TTLock API error: -2012 - token expired")).toBe(false);
    expect(isLockOfflineError("endDate must be after startDate")).toBe(false);
    expect(isLockOfflineError("Bad Request")).toBe(false);
  });

  it("returns false for empty / missing messages", () => {
    expect(isLockOfflineError(null)).toBe(false);
    expect(isLockOfflineError(undefined)).toBe(false);
    expect(isLockOfflineError("")).toBe(false);
  });
});
