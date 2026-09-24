/**
 * Tests for the HARD RUN FLOOR in _jobLockArrivalReport.
 *
 * The job no longer sends any mail (owner decisions 28/7 + 3/8: the routine
 * list mail and then the alarm mails were retired — the live /arrivals page
 * is the only surface). What remains is the hourly audit run: build the
 * report data with the TTLock door audit + force-repairs, which persists the
 * page snapshot. The floor guarantees at most ONE run per hour (each build
 * force-repairs, so minute-cadence runs churned TTLock — 22/7 lesson), and it
 * is held in memory so it survives silently failing settings writes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReservationStateMachine } from "../../reservation-state-machine";

const buildDataMock = vi.fn();

vi.mock("../../lock-arrival-report", () => ({
  buildLockArrivalReportData: (...args: unknown[]) => buildDataMock(...args),
  resolveArrivalsUrl: async () => "https://example.test/arrivals/t/x",
}));

function createStorage() {
  const settings = new Map<string, string>();
  let failSetSetting = false;
  return {
    _settings: settings,
    _failSetSetting(v: boolean) {
      failSetSetting = v;
    },
    async getSetting(key: string) {
      const v = settings.get(key);
      return v !== undefined ? { value: v } : null;
    },
    async setSetting(key: string, value: string) {
      if (failSetSetting) throw new Error("db write failed");
      settings.set(key, value);
      return { key, value };
    },
    async createLog(_log: unknown) {},
  };
}

function createSm(storage: ReturnType<typeof createStorage>) {
  const sm = new ReservationStateMachine(
    storage as any,
    {} as any,
    null as any,
    "test-tenant"
  ) as any;
  return sm;
}

describe("_jobLockArrivalReport hard run floor (no mails — audit/snapshot only)", () => {
  let storage: ReturnType<typeof createStorage>;
  let sm: any;

  beforeEach(() => {
    buildDataMock.mockReset();
    buildDataMock.mockResolvedValue({});
    storage = createStorage();
    sm = createSm(storage);
  });

  it("runs the audit build when due and stamps the last-run setting", async () => {
    sm._arrivalReportDue = true;

    await sm._jobLockArrivalReport();

    expect(buildDataMock).toHaveBeenCalledTimes(1);
    // Full audit + force-repair engine — the run's entire purpose.
    expect(buildDataMock.mock.calls[0][1]).toMatchObject({ runAudit: true });
    expect(storage._settings.has("lock_arrival_report_last_sent_at")).toBe(true);
  });

  it("does not run again inside the hour, even when a new scan flags it due", async () => {
    sm._arrivalReportDue = true;
    await sm._jobLockArrivalReport();
    expect(buildDataMock).toHaveBeenCalledTimes(1);

    sm._arrivalReportDue = true;
    await sm._jobLockArrivalReport();

    expect(buildDataMock).toHaveBeenCalledTimes(1); // no build → no repair churn
  });

  it("holds the floor even when settings writes fail silently", async () => {
    storage._failSetSetting(true);
    sm._arrivalReportDue = true;
    await sm._jobLockArrivalReport(); // build succeeds, persistence fails

    expect(buildDataMock).toHaveBeenCalledTimes(1);
    expect(storage._settings.has("lock_arrival_report_last_sent_at")).toBe(false);

    // Persisted last-run is missing → without the in-memory mirror the
    // fallback path would fire again on the very next tick.
    sm._arrivalReportDue = true;
    await sm._jobLockArrivalReport();

    expect(buildDataMock).toHaveBeenCalledTimes(1);
  });

  it("blocks at 59 min and runs again once the hour has passed", async () => {
    sm._arrivalReportDue = true;
    await sm._jobLockArrivalReport();
    expect(buildDataMock).toHaveBeenCalledTimes(1);

    const rewindTo = (minutesAgo: number) => {
      const past = Date.now() - minutesAgo * 60 * 1000;
      sm._lastReportRunAtMem = past;
      storage._settings.set(
        "lock_arrival_report_last_sent_at",
        new Date(past).toISOString()
      );
    };

    rewindTo(59);
    sm._arrivalReportDue = true;
    await sm._jobLockArrivalReport();
    expect(buildDataMock).toHaveBeenCalledTimes(1);

    rewindTo(61);
    sm._arrivalReportDue = true;
    await sm._jobLockArrivalReport();
    expect(buildDataMock).toHaveBeenCalledTimes(2);
  });

  it("fallback: runs without a scan flag once 75 min have passed since the last run", async () => {
    sm._arrivalReportDue = true;
    await sm._jobLockArrivalReport();
    expect(buildDataMock).toHaveBeenCalledTimes(1);

    // 76 min later, no scan has flagged a report due (e.g. lock-arrival
    // disabled) — the audit run must still happen.
    const past = Date.now() - 76 * 60 * 1000;
    sm._lastReportRunAtMem = past;
    storage._settings.set(
      "lock_arrival_report_last_sent_at",
      new Date(past).toISOString()
    );
    await sm._jobLockArrivalReport();
    expect(buildDataMock).toHaveBeenCalledTimes(2);
  });
});
