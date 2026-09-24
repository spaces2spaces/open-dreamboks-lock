/**
 * Tests for the room-scoped common lock rule (incident 18/8-2026, reservation
 * 73468 in 509.4): the common door "411 Room" had been assigned to all 18
 * spaces of room 509 on 15/7, so every 509 guest's PIN also opened room 411.
 * A room's own door may only serve that room's own spaces.
 */

import { describe, it, expect } from "vitest";
import {
  roomScopedLockPrefix,
  spaceBelongsToRoomScopedLock,
  spacesOutsideRoomScopedLock,
} from "@shared/room-scoped-locks";

describe("roomScopedLockPrefix", () => {
  it("recognises a room's own door", () => {
    expect(roomScopedLockPrefix("411 Room")).toBe("411");
    expect(roomScopedLockPrefix("509 Room")).toBe("509");
    expect(roomScopedLockPrefix("509room")).toBe("509");
    expect(roomScopedLockPrefix(" 411 ROOM ")).toBe("411");
    expect(roomScopedLockPrefix("509")).toBe("509");
  });

  it("leaves floor doors and entrances unrestricted", () => {
    expect(roomScopedLockPrefix("5 Floor")).toBeNull();
    expect(roomScopedLockPrefix("4 Floor")).toBeNull();
    expect(roomScopedLockPrefix("Street Entrance")).toBeNull();
    expect(roomScopedLockPrefix("Main entrance")).toBeNull();
    expect(roomScopedLockPrefix("Parking 6")).toBeNull();
    expect(roomScopedLockPrefix("509.4")).toBeNull();
  });
});

describe("spaceBelongsToRoomScopedLock", () => {
  it("accepts the room itself, its capsules and their twins", () => {
    for (const space of ["509", "509s", "509.1", "509.4", "509.4s", "509.6"]) {
      expect(spaceBelongsToRoomScopedLock("509", space)).toBe(true);
    }
  });

  it("rejects spaces of another room", () => {
    for (const space of ["411", "411.1", "411.2s", "5091", "50"]) {
      expect(spaceBelongsToRoomScopedLock("509", space)).toBe(false);
    }
  });
});

describe("spacesOutsideRoomScopedLock", () => {
  it("names exactly the spaces that caused the 411/509 incident", () => {
    const spaces = ["509", "509.1", "509.4s", "411.1"];
    expect(spacesOutsideRoomScopedLock("411 Room", spaces)).toEqual([
      "509", "509.1", "509.4s",
    ]);
  });

  it("allows a room's own door on all of its spaces", () => {
    expect(spacesOutsideRoomScopedLock("509 Room", ["509", "509.1", "509.6", "509.4s"])).toEqual([]);
  });

  it("never restricts floor doors or entrances", () => {
    const mixed = ["411.1", "509.4", "1201"];
    expect(spacesOutsideRoomScopedLock("5 Floor", mixed)).toEqual([]);
    expect(spacesOutsideRoomScopedLock("Street Entrance", mixed)).toEqual([]);
  });
});
