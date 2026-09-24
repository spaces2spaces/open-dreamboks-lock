/**
 * Arrival-report re-entrancy guard (23/7 incident: ~99 report mails in one
 * night). A report build takes minutes (full TTLock audit + force-repairs)
 * while the scheduler ticks every 60s, and every anti-spam gate is stamped
 * only AFTER the send — so overlapping _jobLockArrivalReport runs all passed
 * every gate and each sent a mail. The guard must:
 *  - run the report at most once at a time (concurrent calls skip)
 *  - release the flag after completion so the next due run still fires
 *  - force-reset a flag stuck > 30 min (hung TTLock call must not silence
 *    the report forever)
 */
import { describe, it, expect } from "vitest";
import { ReservationStateMachine } from "../../reservation-state-machine";
import { createMockStorage } from "../mocks/storage";

function makeSm() {
  const storage = createMockStorage({
    check_in_time: "15:00",
    reservation_checkout_time: "11:00",
    property_timezone: "Europe/Copenhagen",
  });
  const sm = new ReservationStateMachine(storage as any, {} as any, null, "test-tenant");

  let running = 0;
  let maxConcurrent = 0;
  let completed = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });

  // Stub the report body — these tests target only the in-flight guard.
  (sm as any)._runLockArrivalReport = async () => {
    running++;
    maxConcurrent = Math.max(maxConcurrent, running);
    await gate;
    running--;
    completed++;
  };

  return { storage, sm, stats: () => ({ maxConcurrent, completed }), release };
}

describe("_jobLockArrivalReport re-entrancy guard", () => {
  it("concurrent ticks run the report body at most once", async () => {
    const s = makeSm();

    const first = (s.sm as any)._jobLockArrivalReport();
    const second = (s.sm as any)._jobLockArrivalReport();
    const third = (s.sm as any)._jobLockArrivalReport();

    s.release();
    await Promise.all([first, second, third]);

    expect(s.stats().maxConcurrent).toBe(1);
    expect(s.stats().completed).toBe(1);
  });

  it("the flag is released after a run, so the next tick fires again", async () => {
    const s = makeSm();
    s.release(); // gate open — runs complete immediately

    await (s.sm as any)._jobLockArrivalReport();
    await (s.sm as any)._jobLockArrivalReport();

    expect(s.stats().completed).toBe(2);
  });

  it("the flag is released even when the report body throws", async () => {
    const s = makeSm();
    let calls = 0;
    (s.sm as any)._runLockArrivalReport = async () => {
      calls++;
      throw new Error("boom");
    };

    await (s.sm as any)._jobLockArrivalReport(); // error is caught + logged
    await (s.sm as any)._jobLockArrivalReport();

    expect(calls).toBe(2);
    const errors = s.storage._logs.filter((l: any) => l.level === "error");
    expect(errors.length).toBe(2);
  });

  it("a flag stuck for over 30 minutes is force-reset and the run proceeds", async () => {
    const s = makeSm();
    s.release();
    (s.sm as any)._reportJobStartedAt = Date.now() - 31 * 60 * 1000;

    await (s.sm as any)._jobLockArrivalReport();

    expect(s.stats().completed).toBe(1);
    const warns = s.storage._logs.filter((l: any) => l.level === "warn" && String(l.message).includes("stuck"));
    expect(warns.length).toBe(1);
  });

  it("a recently set flag (not stuck) blocks the run", async () => {
    const s = makeSm();
    s.release();
    (s.sm as any)._reportJobStartedAt = Date.now() - 5 * 60 * 1000;

    await (s.sm as any)._jobLockArrivalReport();

    expect(s.stats().completed).toBe(0);
  });
});
