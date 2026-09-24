/**
 * Mock TTLockClient — recorder pattern.
 * Stores all calls and passcodes per lock in memory.
 * Returns success by default; can be configured to fail.
 */

interface PasscodeRecord {
  id: number;
  lockId: string;
  code: string;
  name: string;
  startDate: Date;
  endDate: Date;
}

interface CallRecord {
  method: string;
  args: any[];
  timestamp: number;
}

let nextKeyId = 1000;

export function createMockTTLockClient() {
  const calls: CallRecord[] = [];
  const passcodes = new Map<string, PasscodeRecord[]>(); // lockId → passcodes
  let failNext: string | null = null;
  let failWithCodeConfig: { method: string; errorCode: number } | null = null;
  let failWithCodeCountdown: { method: string; errorCode: number; remaining: number } | null = null;
  const failListPasscodesLocks = new Set<string>();
  const failListPasscodesCounts = new Map<string, number>(); // lockId → remaining failures
  // Locks where listPasscodes answers SUCCESSFULLY with an empty list even
  // though codes exist — simulates the gateway-flap / stale-cloud read that
  // caused the 21/7 mass "deleted" marking.
  const softEmptyListLocks = new Set<string>();
  // Configurable unlock history per lock (door-code audit's false-positive guard).
  const unlockRecords = new Map<string, Array<{ keyboardPwd?: string; success: boolean; lockDate?: number }>>();

  function record(method: string, args: any[]) {
    calls.push({ method, args, timestamp: Date.now() });
  }

  function getOrCreateLockPasscodes(lockId: string): PasscodeRecord[] {
    if (!passcodes.has(lockId)) passcodes.set(lockId, []);
    return passcodes.get(lockId)!;
  }

  return {
    // ── TTLockClient API methods ──

    async addPasscode(
      lockId: string,
      passcode: string,
      name: string,
      options: { startDate: Date; endDate: Date; keyboardPwdVersion: number }
    ): Promise<{ id: number; code: string }> {
      record("addPasscode", [lockId, passcode, name, options]);
      if (failWithCodeCountdown && failWithCodeCountdown.method === "addPasscode" && failWithCodeCountdown.remaining > 0) {
        failWithCodeCountdown.remaining--;
        throw new Error(`TTLock API error: ${failWithCodeCountdown.errorCode} - addPasscode failed`);
      }
      if (failWithCodeConfig && failWithCodeConfig.method === "addPasscode") {
        const code = failWithCodeConfig.errorCode;
        // Don't clear — persistent until manually cleared
        throw new Error(`TTLock API error: ${code} - addPasscode failed`);
      }
      if (failNext === "addPasscode") {
        failNext = null;
        throw new Error("TTLock API error: addPasscode failed");
      }
      const keyId = nextKeyId++;
      const lockCodes = getOrCreateLockPasscodes(lockId);
      lockCodes.push({
        id: keyId,
        lockId,
        code: passcode,
        name,
        startDate: options.startDate,
        endDate: options.endDate,
      });
      return { id: keyId, code: passcode };
    },

    async deletePasscode(
      lockId: string,
      passcodeId: number,
      deleteType?: number
    ): Promise<void> {
      record("deletePasscode", [lockId, passcodeId, deleteType]);
      if (failNext === "deletePasscode") {
        failNext = null;
        throw new Error("TTLock API error: deletePasscode failed");
      }
      const lockCodes = getOrCreateLockPasscodes(lockId);
      const idx = lockCodes.findIndex((p) => p.id === passcodeId);
      if (idx >= 0) lockCodes.splice(idx, 1);
    },

    async updatePasscode(
      lockId: string,
      passcodeId: number,
      passcode: string,
      startDate: Date,
      endDate: Date
    ): Promise<void> {
      record("updatePasscode", [lockId, passcodeId, passcode, startDate, endDate]);
      if (failNext === "updatePasscode") {
        failNext = null;
        throw new Error("TTLock API error: updatePasscode failed");
      }
      const lockCodes = getOrCreateLockPasscodes(lockId);
      const existing = lockCodes.find((p) => p.id === passcodeId);
      if (existing) {
        existing.startDate = startDate;
        existing.endDate = endDate;
      }
    },

    async listPasscodes(
      lockId: string,
      _pageNo?: number,
      _pageSize?: number
    ): Promise<Array<{ id: number; code: string; name: string; type: number; startDate: number; endDate: number }>> {
      record("listPasscodes", [lockId]);
      if (failListPasscodesLocks.has(lockId)) {
        throw new Error(`TTLock API error: listPasscodes failed for lock ${lockId}`);
      }
      const remaining = failListPasscodesCounts.get(lockId);
      if (remaining !== undefined && remaining > 0) {
        failListPasscodesCounts.set(lockId, remaining - 1);
        throw new Error(`TTLock API error: listPasscodes failed for lock ${lockId} (countdown)`);
      }
      if (softEmptyListLocks.has(lockId)) {
        return [];
      }
      const lockCodes = getOrCreateLockPasscodes(lockId);
      return lockCodes.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        type: 3,
        startDate: p.startDate.getTime(),
        endDate: p.endDate.getTime(),
      }));
    },

    async getUnlockRecords(
      lockId: string,
      _opts?: { startDate?: number; endDate?: number; pageSize?: number }
    ): Promise<Array<{ keyboardPwd?: string; success: boolean; lockDate?: number }>> {
      record("getUnlockRecords", [lockId]);
      return unlockRecords.get(lockId) || [];
    },

    async getLockStatus(lockId: string): Promise<{
      battery: number;
      name: string;
      mac: string;
      keyboardPwdVersion: number;
    } | null> {
      record("getLockStatus", [lockId]);
      return {
        battery: 95,
        name: `Lock-${lockId}`,
        mac: "AA:BB:CC:DD:EE:FF",
        keyboardPwdVersion: 4,
      };
    },

    // ── Test helpers ──

    reset() {
      calls.length = 0;
      passcodes.clear();
      nextKeyId = 1000;
      failNext = null;
      failWithCodeConfig = null;
      failWithCodeCountdown = null;
      failListPasscodesLocks.clear();
      failListPasscodesCounts.clear();
      softEmptyListLocks.clear();
      unlockRecords.clear();
    },

    getCallsFor(method: string): CallRecord[] {
      return calls.filter((c) => c.method === method);
    },

    getAllCalls(): CallRecord[] {
      return [...calls];
    },

    getLocksWithCode(code: string): string[] {
      const result: string[] = [];
      for (const [lockId, codes] of passcodes) {
        if (codes.some((p) => p.code === code)) result.push(lockId);
      }
      return result;
    },

    getPasscodesForLock(lockId: string): PasscodeRecord[] {
      return getOrCreateLockPasscodes(lockId);
    },

    /** Make the next call to `method` throw an error */
    failNextCall(method: string) {
      failNext = method;
    },

    /** Make `method` persistently throw with a specific TTLock error code (e.g. -3007) */
    failWithCode(method: string, errorCode: number) {
      failWithCodeConfig = { method, errorCode };
    },

    /** Clear the failWithCode configuration */
    clearFailWithCode() {
      failWithCodeConfig = null;
    },

    /** Make listPasscodes fail for a specific lock */
    failListPasscodesForLock(lockId: string) {
      failListPasscodesLocks.add(lockId);
    },

    /** Clear listPasscodes failure for a specific lock */
    clearFailListPasscodesForLock(lockId: string) {
      failListPasscodesLocks.delete(lockId);
    },

    /** Clear all listPasscodes failures */
    clearAllListPasscodesFailures() {
      failListPasscodesLocks.clear();
      failListPasscodesCounts.clear();
    },

    /** Fail listPasscodes for a specific lock N times, then succeed */
    failListPasscodesForLockNTimes(lockId: string, count: number) {
      failListPasscodesCounts.set(lockId, count);
    },

    /** listPasscodes answers successfully but with an EMPTY list for this lock
     *  (gateway-flap / stale-cloud simulation — no exception thrown) */
    setSoftEmptyListForLock(lockId: string) {
      softEmptyListLocks.add(lockId);
    },

    /** Seed unlock history for a lock (audit false-positive guard tests) */
    _setUnlockRecords(lockId: string, records: Array<{ keyboardPwd?: string; success: boolean; lockDate?: number }>) {
      unlockRecords.set(lockId, records);
    },

    /** Clear the soft-empty simulation for a lock */
    clearSoftEmptyListForLock(lockId: string) {
      softEmptyListLocks.delete(lockId);
    },

    /** Make `method` fail N times with a specific error code, then succeed */
    failWithCodeNTimes(method: string, errorCode: number, count: number) {
      failWithCodeCountdown = { method, errorCode, remaining: count };
    },
  };
}

export type MockTTLockClient = ReturnType<typeof createMockTTLockClient>;
