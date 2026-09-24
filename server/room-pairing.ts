/**
 * Twin spaces: "401" (2-person rate) and "401s" (1-person rate) are the SAME
 * physical capsule — two MEWS spaces sharing one bed and one lock (verified:
 * both map to lock "401"). Any occupancy on one twin occupies the other.
 *
 * Every availability computation and occupancy guard must therefore work on
 * the PHYSICAL capsule (the twin set), never a single roomId.
 */

export function physicalRoomKey(name: string): string {
  // "401s" → "401"; non-numeric names (common areas etc.) are their own key.
  return /^\d+s$/i.test(name) ? name.slice(0, -1) : name;
}

/** roomId → all roomIds sharing the physical capsule (including itself). */
export function buildTwinMap(rooms: Array<{ id: string; name: string }>): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const r of rooms) {
    const key = physicalRoomKey(r.name);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r.id);
  }
  const twins = new Map<string, string[]>();
  for (const ids of Array.from(byKey.values())) {
    for (const id of ids) twins.set(id, ids);
  }
  return twins;
}

/** Convenience: the twin roomIds for one roomId (falls back to itself). */
export function twinRoomIds(rooms: Array<{ id: string; name: string }>, roomId: string): string[] {
  return buildTwinMap(rooms).get(roomId) ?? [roomId];
}

/**
 * Does this hourly booking occupy any of the given rooms? Matches the booked
 * room AND any grace-move room (lockKeyIds[].graceRoomId): while an arrived
 * guest is being moved, their code is live on BOTH capsules, so every sale
 * path (hourly, early check-in, late checkout) must treat both as taken.
 */
export function hourlyBookingBlocksRooms(
  hb: { roomId: string; lockKeyIds?: unknown },
  roomIds: ReadonlySet<string> | string[],
): boolean {
  const set = Array.isArray(roomIds) ? new Set(roomIds) : roomIds;
  if (set.has(hb.roomId)) return true;
  const entries = (hb.lockKeyIds as Array<{ graceRoomId?: string }> | null | undefined) || [];
  for (const e of entries) {
    if (e?.graceRoomId && set.has(e.graceRoomId)) return true;
  }
  return false;
}
