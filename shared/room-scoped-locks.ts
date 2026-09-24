/**
 * Room-scoped common locks.
 *
 * A capsule room has ONE physical door shared by every capsule inside it. That
 * door is modelled as a `common` lock named after the room ("411 Room",
 * "509 Room") because several MEWS spaces sit behind it — which also means the
 * "one room lock = one space" exclusivity guard does NOT apply to it.
 *
 * That gap bit us on 15/7-2026: in the lock mapping UI the lock "411 Room" was
 * still selected while the 18 spaces of room 509 were added, so every 509 guest
 * got a PIN that opened room 411's door (found 18/8-2026, reservation 73468).
 *
 * Rule enforced here: a common lock whose name is a room number may only be
 * assigned to that room's own spaces — "411 Room" → 411, 411.1, 411.2s, …
 * Locks named after a floor or an entrance ("5 Floor", "Street Entrance") are
 * not room-scoped and stay unrestricted.
 */

/** "411 Room" → "411", "509" → "509". Non-room-scoped names → null. */
export function roomScopedLockPrefix(lockName: string): string | null {
  const match = /^\s*(\d+)(?:\s*room)?\s*$/i.exec(lockName);
  return match ? match[1] : null;
}

/** Does space `roomName` sit behind the room-scoped lock for `prefix`? */
export function spaceBelongsToRoomScopedLock(prefix: string, roomName: string): boolean {
  // "509.4s" and "509s" are twin spaces of the same physical capsule/room.
  const base = roomName.trim().replace(/s$/i, "");
  return base === prefix || base.startsWith(`${prefix}.`);
}

/**
 * Spaces that must NOT be assigned to this lock. Empty when the lock isn't
 * room-scoped (floor doors, entrances) or every space belongs to it.
 */
export function spacesOutsideRoomScopedLock(
  lockName: string,
  roomNames: string[],
): string[] {
  const prefix = roomScopedLockPrefix(lockName);
  if (!prefix) return [];
  return roomNames.filter(name => !spaceBelongsToRoomScopedLock(prefix, name));
}
