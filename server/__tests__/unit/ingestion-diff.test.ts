/**
 * Tests for changedReservationFields — the "diff before write" guard that
 * stops the MEWS sync from rewriting unchanged reservation rows (and spamming
 * the log) on every poll cycle.
 *
 * Contract: returns the names of fields that would actually be persisted and
 * differ. Empty array = a write would be a pure no-op (skip update + log).
 * Must be conservative: never return [] when a real change exists.
 */

import { describe, it, expect } from "vitest";
import { changedReservationFields } from "../../ingestion-processor";

describe("changedReservationFields", () => {
  const base = {
    status: "Confirmed",
    firstName: "Pia",
    lastName: "Harm",
    email: "pia@example.com",
    arrival: new Date("2026-06-10T13:00:00Z"),
    departure: new Date("2026-06-12T09:00:00Z"),
    roomId: "room-1",
    adults: 1,
    children: 0,
    owing: null,
  };

  it("returns [] when nothing changed (identical data, dates as Date objects)", () => {
    const data = {
      status: "Confirmed",
      firstName: "Pia",
      lastName: "Harm",
      email: "pia@example.com",
      arrival: new Date("2026-06-10T13:00:00Z"),
      departure: new Date("2026-06-12T09:00:00Z"),
      roomId: "room-1",
      adults: 1,
      children: 0,
    };
    expect(changedReservationFields(base, data)).toEqual([]);
  });

  it("detects a status change", () => {
    expect(changedReservationFields(base, { status: "Checked-in" })).toEqual(["status"]);
  });

  it("detects an arrival timestamp change (compared by time, not reference)", () => {
    // Same instant, different Date object → not a change
    expect(
      changedReservationFields(base, { arrival: new Date("2026-06-10T13:00:00Z") })
    ).toEqual([]);
    // Different instant → change
    expect(
      changedReservationFields(base, { arrival: new Date("2026-06-11T13:00:00Z") })
    ).toEqual(["arrival"]);
  });

  it("ignores undefined fields (updateReservation never writes them)", () => {
    // email undefined in incoming data must NOT count as a change, even though
    // the existing row has a value — undefined is skipped by the writer.
    expect(changedReservationFields(base, { email: undefined })).toEqual([]);
  });

  it("treats null as a real (clearing) write when the existing value is set", () => {
    // roomId being cleared to null IS a persisted change.
    expect(changedReservationFields(base, { roomId: null })).toEqual(["roomId"]);
  });

  it("treats existing-null → new-value as a change", () => {
    expect(changedReservationFields(base, { owing: "150.00" })).toEqual(["owing"]);
  });

  it("treats null == null as unchanged", () => {
    expect(changedReservationFields(base, { owing: null })).toEqual([]);
  });

  it("detects numeric field changes (adults/children)", () => {
    expect(changedReservationFields(base, { adults: 2 })).toEqual(["adults"]);
    expect(changedReservationFields(base, { adults: 1, children: 0 })).toEqual([]);
  });

  it("reports multiple changed fields together", () => {
    const changed = changedReservationFields(base, {
      status: "Cancelled",
      adults: 3,
      firstName: "Pia",
    });
    expect(changed.sort()).toEqual(["adults", "status"]);
  });
});
