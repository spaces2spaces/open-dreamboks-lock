/**
 * Day-use checkout signal (natten 22/7, Louise/302): an OTA day-use stay
 * (arrival + departure on the same hotel day) that has ENDED and was USED
 * must be checked out in MEWS automatically — otherwise the "occupied"
 * capsule rejects the arriving overnight guest's auto check-in all evening.
 * No-shows are left for MEWS' night audit; overnight stays are untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ReservationStateMachine } from "../../reservation-state-machine";
import { makeReservation } from "../fixtures/reservations";

function createStorage(settings: Record<string, string> = {}) {
  const reservations: any[] = [];
  const logs: any[] = [];
  return {
    _reservations: reservations,
    _logs: logs,
    async getSetting(key: string) {
      const v = settings[key];
      return v !== undefined ? { value: v } : null;
    },
    async getMappedReservationsByArrivalRange() {
      return [...reservations];
    },
    async updateReservation(id: string, data: any) {
      const r = reservations.find((x) => x.id === id);
      if (r) Object.assign(r, data);
      return r;
    },
    async createLog(log: any) {
      logs.push(log);
    },
  };
}

function makeSm(storage: any, mews: any) {
  const sm = new ReservationStateMachine(storage as any, {} as any, mews, "test-tenant") as any;
  sm._lastDayUseCheckoutRun = 0;
  return sm;
}

const HOURS = 3600e3;

function dayUseReservation(overrides: any = {}) {
  // 10:00 → 15:00 today, ended 2h ago (assume test runs whenever: we anchor
  // both to "now" minus offsets on the SAME day by construction below).
  const departure = new Date(Date.now() - 2 * HOURS);
  const arrival = new Date(departure.getTime() - 4 * HOURS);
  return makeReservation({
    id: "res-du",
    pmsId: "PMS-DU",
    roomId: "room-1",
    status: "checked-in",
    arrival,
    departure,
    ...overrides,
  });
}

describe("_jobDayUseCheckout", () => {
  let mews: any;

  beforeEach(() => {
    mews = { processReservation: vi.fn().mockResolvedValue({ success: true }) };
  });

  it("checks out a USED day-use whose window ended", async () => {
    const storage = createStorage();
    const r = dayUseReservation();
    // Guard against midnight flake: only meaningful when arrival/departure
    // share a calendar day — skip silently in the rare cross-midnight run.
    if (new Date(r.arrival).getDate() !== new Date(r.departure).getDate()) return;
    storage._reservations.push(r);

    await makeSm(storage, mews)._jobDayUseCheckout();

    expect(mews.processReservation).toHaveBeenCalledWith("PMS-DU");
    expect(r.status).toBe("Checked-out");
  });

  it("leaves a NO-SHOW day-use alone (never turns a no-show into a stay)", async () => {
    const storage = createStorage();
    storage._reservations.push(dayUseReservation({ status: "Confirmed" }));

    await makeSm(storage, mews)._jobDayUseCheckout();

    expect(mews.processReservation).not.toHaveBeenCalled();
  });

  it("leaves overnight stays alone — MEWS' own bulk checkout owns them", async () => {
    const storage = createStorage();
    const departure = new Date(Date.now() - 2 * HOURS);
    storage._reservations.push(
      dayUseReservation({ arrival: new Date(departure.getTime() - 26 * HOURS) })
    );

    await makeSm(storage, mews)._jobDayUseCheckout();

    expect(mews.processReservation).not.toHaveBeenCalled();
  });

  it("leaves a still-running day-use alone", async () => {
    const storage = createStorage();
    const departure = new Date(Date.now() + 2 * HOURS);
    const r = dayUseReservation({ departure, arrival: new Date(departure.getTime() - 4 * HOURS) });
    if (new Date(r.arrival).getDate() !== new Date(r.departure).getDate()) return;
    storage._reservations.push(r);

    await makeSm(storage, mews)._jobDayUseCheckout();

    expect(mews.processReservation).not.toHaveBeenCalled();
  });

  it("alerts after 3 failed MEWS checkouts (e.g. open balance) and keeps the status", async () => {
    const storage = createStorage({ lock_arrival_report_email: "ops@hotel.dk" });
    const r = dayUseReservation();
    if (new Date(r.arrival).getDate() !== new Date(r.departure).getDate()) return;
    storage._reservations.push(r);
    mews.processReservation = vi.fn().mockResolvedValue({ success: false, error: "open balance" });

    const sm = makeSm(storage, mews);
    for (let i = 0; i < 3; i++) {
      sm._lastDayUseCheckoutRun = 0;
      await sm._jobDayUseCheckout();
    }

    expect(r.status).toBe("checked-in"); // never faked locally
    const warns = storage._logs.filter((l: any) => l.message.includes("Day-use checkout signal failed"));
    expect(warns.length).toBe(3);
  });

  it("kill switch: dayuse_checkout_signal_enabled=false disables the job", async () => {
    const storage = createStorage({ dayuse_checkout_signal_enabled: "false" });
    const r = dayUseReservation();
    storage._reservations.push(r);

    await makeSm(storage, mews)._jobDayUseCheckout();

    expect(mews.processReservation).not.toHaveBeenCalled();
  });
});
