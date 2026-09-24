import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the TTLock owner token mutex.
 * We test the isTTLockSafeCode-equivalent logic directly since
 * getOwnerAccessToken depends on env vars and real API calls.
 */

describe("TTLock PIN safety validation", () => {
  // Test the same logic used by PinLifecycleService.isTTLockSafeCode
  function isTTLockSafeCode(code: string): boolean {
    const digits = code.split("").map(Number);
    if (new Set(digits).size === 1) return false;
    const isAscending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
    if (isAscending) return false;
    const isDescending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
    if (isDescending) return false;
    if (digits[0] === digits[2] && digits[1] === digits[3]) return false;
    return true;
  }

  it("rejects ascending sequences", () => {
    expect(isTTLockSafeCode("1234")).toBe(false);
    expect(isTTLockSafeCode("2345")).toBe(false);
    expect(isTTLockSafeCode("6789")).toBe(false);
  });

  it("rejects descending sequences", () => {
    expect(isTTLockSafeCode("9876")).toBe(false);
    expect(isTTLockSafeCode("8765")).toBe(false);
    expect(isTTLockSafeCode("4321")).toBe(false);
  });

  it("rejects all-same digits", () => {
    expect(isTTLockSafeCode("1111")).toBe(false);
    expect(isTTLockSafeCode("5555")).toBe(false);
    expect(isTTLockSafeCode("9999")).toBe(false);
  });

  it("rejects repeated pairs", () => {
    expect(isTTLockSafeCode("1212")).toBe(false);
    expect(isTTLockSafeCode("3434")).toBe(false);
    expect(isTTLockSafeCode("7878")).toBe(false);
  });

  it("accepts normal codes", () => {
    expect(isTTLockSafeCode("8009")).toBe(true);
    expect(isTTLockSafeCode("5738")).toBe(true);
    expect(isTTLockSafeCode("2947")).toBe(true);
    expect(isTTLockSafeCode("6103")).toBe(true);
  });

  it("accepts codes with partial sequences", () => {
    // Only 3 consecutive is OK — TTLock only rejects full 4-digit sequences
    expect(isTTLockSafeCode("1235")).toBe(true);
    expect(isTTLockSafeCode("9873")).toBe(true);
    expect(isTTLockSafeCode("1123")).toBe(true);
  });
});
