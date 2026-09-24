import type { ITenantStorage } from "./storage";
import { createOwnerClient, TTLockClient } from "./ttlock-client";

// End-to-end verification of common-area doors (main entrance etc.): compares
// the lock's ACTUAL passcode list against every guest code that should be
// usable right now. This is the human safety net behind push + auto-repair —
// DB state alone cannot be trusted (a synced-looking entry can be stale or
// missing on the physical lock).

export interface DoorCodeGap {
  guestName: string;
  code: string;
  lockName: string;
  ttlockId: string;
  /** Enables detection→action: the report layer force-repairs this reservation. */
  reservationId: string | null;
  /** "missing" = code not on lock at all; "stale-entry" = on lock but its window doesn't cover now */
  reason: "missing" | "stale-entry";
  /** "room" = the guest's own capsule lock; "common" = shared door (main entrance etc.) */
  lockKind: "room" | "common";
}

export async function auditCommonDoorCodes(
  storage: ITenantStorage,
  client?: TTLockClient,
): Promise<{ gaps: DoorCodeGap[]; offlineLocks: string[]; offlineDoorsDetailed: Array<{ lockName: string; ttlockId: string }> }> {
  let ttlock = client;
  if (!ttlock) {
    try {
      ttlock = await createOwnerClient();
    } catch {
      return { gaps: [], offlineLocks: [], offlineDoorsDetailed: [] }; // no owner credentials — audit unavailable, never break the report
    }
  }

  const pins = await storage.getRepairablePins();
  const now = Date.now();
  const listCache = new Map<string, Array<{ code: string; startDate: number; endDate: number }> | null>();
  const gaps: DoorCodeGap[] = [];
  const seen = new Set<string>(); // dedupe: same code can sit on several pin rows

  // Room locks are audited too (owner request 22/7: "does Karim have a code on
  // 724?" must be answered by the SYSTEM, hourly, not by a human at the lock).
  // Opt-out via audit_room_locks=false if TTLock API load ever becomes a concern.
  const auditRoomLocks = (await storage.getSetting("audit_room_locks"))?.value !== "false";

  // confirmedUnlisted entries: the lock has repeatedly asserted the code exists
  // (-3007) while the cloud list cannot show it — hardware unlock records prove
  // such codes work. List-based auditing of those locks is meaningless noise.
  const parseEntries = (v: unknown): any[] => {
    let value = v as any;
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { return []; }
    }
    return Array.isArray(value) ? value : [];
  };
  const isConfirmedUnlisted = (pin: { roomLockKeyIds?: unknown; commonAreaKeyIds?: unknown }, ttlockId: string) =>
    [...parseEntries(pin.roomLockKeyIds), ...parseEntries(pin.commonAreaKeyIds)]
      .some(e => e?.ttlockId === ttlockId && e?.confirmedUnlisted);

  for (const pin of pins) {
    if (!pin.roomId || !pin.code) continue;
    if (pin.validFrom && new Date(pin.validFrom).getTime() > now) continue; // not yet active

    const assignments = await storage.getRoomLockAssignments(pin.roomId);
    for (const a of assignments) {
      const ld = a.lockDevice;
      if (!ld?.ttlockId) continue;
      const lockKind: "room" | "common" = ld.lockType === "room" ? "room" : "common";
      if (lockKind === "room" && !auditRoomLocks) continue;
      if (isConfirmedUnlisted(pin, ld.ttlockId)) continue; // cloud-blind but proven on lock

      let list = listCache.get(ld.ttlockId);
      if (list === undefined) {
        try {
          list = await ttlock.listPasscodes(ld.ttlockId);
        } catch {
          list = null; // listing failed — skip this lock rather than false-alarm
        }
        listCache.set(ld.ttlockId, list);
      }
      if (!list) continue;

      const entries = list.filter(p => p.code === pin.code);
      const usableNow = entries.some(p => p.startDate <= now && (p.endDate === 0 || p.endDate > now));
      const dedupeKey = `${pin.code}|${ld.ttlockId}`;
      if (!usableNow && !seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        gaps.push({
          guestName: pin.name || `kode ${pin.code}`,
          code: pin.code,
          lockName: ld.name,
          ttlockId: ld.ttlockId,
          reservationId: pin.reservationId ?? null,
          reason: entries.length ? "stale-entry" : "missing",
          lockKind,
        });
      }
    }
  }

  // False-positive guard: the cloud passcode list can miss codes created via
  // Bluetooth (the TTLock app). If the lock's own unlock history shows the code
  // used SUCCESSFULLY recently, it is on the lock — drop the alarm.
  let remaining = gaps;
  if (gaps.length > 0) {
    const recentlyUsed = new Set<string>(); // "code|ttlockId"
    const sinceMs = now - 24 * 3600 * 1000;
    for (const lockTtlockId of Array.from(new Set(gaps.map(g => g.ttlockId)))) {
      try {
        const records = await ttlock.getUnlockRecords(lockTtlockId, { startDate: sinceMs, endDate: now, pageSize: 200 });
        for (const r of records) {
          if (r.keyboardPwd && r.success) recentlyUsed.add(`${r.keyboardPwd}|${lockTtlockId}`);
        }
      } catch {
        // history unavailable — keep the alarm rather than hide it
      }
    }
    remaining = gaps.filter(g => !recentlyUsed.has(`${g.code}|${g.ttlockId}`));
  }

  // OFFLINE locks (gateway down, e.g. Parking 6): codes CANNOT be pushed there
  // until the gateway returns, so per-guest alarm lines are pure noise. Detect
  // via the repair/push jobs' own "<lock> offline — deferred" log lines from
  // the last 3 hours, and report the lock as offline instead of listing gaps.
  const offlineLocks: string[] = [];
  if (remaining.length > 0) {
    try {
      const recentLogs = await storage.getAllLogs(600);
      const cutoff = now - 3 * 3600 * 1000;
      for (const lockName of Array.from(new Set(remaining.map(g => g.lockName)))) {
        const isOffline = recentLogs.some(
          (l) => new Date(l.timestamp).getTime() > cutoff && (l.message || "").includes(`${lockName} offline`)
        );
        if (isOffline) offlineLocks.push(lockName);
      }
    } catch { /* log lookup failed — keep all alarms */ }
  }

  // Detail variant so the report layer can look up per-lock offline duration
  // (settings are keyed by ttlockId, the report otherwise only has names).
  const offlineDoorsDetailed = offlineLocks.map(lockName => ({
    lockName,
    ttlockId: remaining.find(g => g.lockName === lockName)?.ttlockId || "",
  }));

  return {
    gaps: remaining.filter(g => !offlineLocks.includes(g.lockName)),
    offlineLocks,
    offlineDoorsDetailed,
  };
}
