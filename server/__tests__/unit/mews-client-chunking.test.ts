/**
 * Tests for MewsClient reservations/getAll interval chunking.
 *
 * MEWS' connector rejects a getAll TimeFilter window whose interval exceeds
 * 100 hours ("The interval must not exceed 100:00:00"). Our ~30-day sync
 * windows blew past that and silently broke ALL reservation syncing. The fix
 * splits any window into ≤96h slices and merges the per-slice responses,
 * deduped by Id. These tests lock in that behaviour.
 */

import { describe, it, expect } from "vitest";
import { MewsClient } from "../../mews-client";

const H = 3600 * 1000;

// Replace the private network call with a capturing stub.
function stub(client: MewsClient, responder: (body: any) => any): any[] {
  const calls: any[] = [];
  (client as any).makeRequest = async (_endpoint: string, body: any) => {
    calls.push(body);
    return responder(body);
  };
  return calls;
}

describe("MewsClient reservations/getAll interval chunking", () => {
  it("splits a >96h window into ≤96h contiguous slices covering the full range", async () => {
    const client = new MewsClient("ct", "at", "production");
    const calls = stub(client, () => ({ Reservations: [] }));

    const start = "2026-07-01T00:00:00.000Z";
    const end = "2026-07-31T00:00:00.000Z"; // 30 days = 720h → 8 slices
    await client.getReservationsByTimeFilter(start, end);

    expect(calls.length).toBe(8);
    for (const c of calls) {
      const dur = new Date(c.EndUtc).getTime() - new Date(c.StartUtc).getTime();
      expect(dur).toBeLessThanOrEqual(96 * H);
      expect(c.TimeFilter).toBe("Start");
    }
    // Contiguous + full coverage: first slice starts at start, last ends at end,
    // every slice begins where the previous ended.
    expect(calls[0].StartUtc).toBe(new Date(start).toISOString());
    expect(calls[calls.length - 1].EndUtc).toBe(new Date(end).toISOString());
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].StartUtc).toBe(calls[i - 1].EndUtc);
    }
  });

  it("makes exactly one call for a window within 96h (fast-poll path unchanged)", async () => {
    const client = new MewsClient("ct", "at", "production");
    const calls = stub(client, () => ({ Reservations: [] }));
    await client.getReservationsByTimeFilter("2026-07-01T00:00:00.000Z", "2026-07-03T00:00:00.000Z"); // 48h
    expect(calls.length).toBe(1);
  });

  it("merges and dedupes reservations/groups/categories by Id across slices", async () => {
    const client = new MewsClient("ct", "at", "production");
    let i = 0;
    stub(client, () => {
      const slice = i++;
      return {
        Reservations: [{ Id: "R1" }, { Id: `R-slice-${slice}` }], // R1 repeats every slice
        ReservationGroups: [{ Id: "G1" }],
        ResourceCategories: [{ Id: "C1" }],
      };
    });

    const res = await client.getReservationsByTimeFilter(
      "2026-07-01T00:00:00.000Z",
      "2026-07-13T00:00:00.000Z", // 12 days = 288h → 3 slices
    );

    expect(res.Reservations.map((r) => r.Id).sort()).toEqual([
      "R-slice-0",
      "R-slice-1",
      "R-slice-2",
      "R1",
    ]);
    expect(res.ReservationGroups!.map((g) => g.Id)).toEqual(["G1"]); // deduped across 3 slices
    expect(res.ResourceCategories!.map((c) => c.Id)).toEqual(["C1"]); // deduped across 3 slices
  });

  it("carries the right TimeFilter + States for in-house (End) vs updated (Updated)", async () => {
    const client = new MewsClient("ct", "at", "production");
    const calls = stub(client, () => ({ Reservations: [] }));

    await client.getInHouseReservations(30);
    await client.getUpdatedReservations(new Date(Date.now() - 2 * H)); // 2h back → single slice

    const inHouse = calls.filter((c) => c.TimeFilter === "End");
    const updated = calls.filter((c) => c.TimeFilter === "Updated");
    expect(inHouse.length).toBeGreaterThan(1); // 30-day horizon → chunked
    expect(inHouse[0].States).toEqual(["Started", "Processed"]);
    expect(updated.length).toBe(1);
    expect(updated[0].States).toEqual(["Confirmed", "Started", "Processed", "Canceled"]);
  });
});
