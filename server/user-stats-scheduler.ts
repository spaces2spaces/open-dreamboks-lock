import sgMail from "@sendgrid/mail";
import { ITenantStorage } from "./storage";
import { DateTime } from "luxon";

// Fallback when the per-tenant `report_email` setting is empty. Unset = report skipped.
const DEFAULT_REPORT_RECIPIENT = process.env.USER_STATS_REPORT_EMAIL || "";
const TIMEZONE = "Europe/Copenhagen";
const SEND_HOUR = 9; // 09:00 CET
const SEND_HOUR_LABEL = `${String(SEND_HOUR).padStart(2, "0")}:00`;

interface RoomLockUsage {
  room: string;
  pin: number;
  ekey: number;
  sys: number;
  fail: number;
}

export class UserStatsScheduler {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastRunDate: string | null = null;

  constructor(private storage: ITenantStorage) {}

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[DailyReport] Scheduler started - combined report sends at ${SEND_HOUR_LABEL} CET`);

    this.intervalId = setInterval(async () => {
      await this.checkAndRun();
    }, 60000);

    await this.checkAndRun();
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
  }

  private async checkAndRun() {
    try {
      const now = DateTime.now().setZone(TIMEZONE);
      const today = now.toFormat("yyyy-MM-dd");

      if (this.lastRunDate === today) return;
      if (now.hour < SEND_HOUR) return;

      this.lastRunDate = today;
      console.log("[DailyReport] Sending combined daily report...");
      await this.sendReport();
    } catch (error) {
      console.error("[DailyReport] Error:", error);
    }
  }

  // Can be called manually (e.g., from an admin route)
  async sendReport() {
    try {
      const now = DateTime.now().setZone(TIMEZONE);
      // Period: yesterday SEND_HOUR to today SEND_HOUR CET
      const periodEnd = now.set({ hour: SEND_HOUR, minute: 0, second: 0, millisecond: 0 });
      const periodStart = periodEnd.minus({ days: 1 });

      const fromIso = periodStart.toUTC().toISO()!;
      const toIso = periodEnd.toUTC().toISO()!;
      const dateLabel = periodStart.toFormat("dd/MM/yyyy");

      // Lock-usage section covers the full previous calendar day (00:00–24:00 CET)
      const lockDayEnd = now.startOf("day");
      const lockDayStart = lockDayEnd.minus({ days: 1 });
      const lockDayLabel = lockDayStart.toFormat("dd/MM/yyyy");
      const lockUsage = await this.queryRoomLockUsage(
        lockDayStart.toMillis(),
        lockDayEnd.toMillis()
      );

      // Gather user statistics
      const stats = await this.gatherStats(fromIso, toIso);

      // Gather activity tables data
      const [invitations, boardingPasses, unlocks] = await Promise.all([
        this.queryInvitations(fromIso, toIso),
        this.queryBoardingPasses(fromIso, toIso),
        this.queryUnlocks(fromIso, toIso),
      ]);

      // Fetch current reservation status for all relevant pms_ids
      const allPmsIds = [...new Set([
        ...invitations.map((r) => r.pms_id),
        ...boardingPasses.map((r) => r.pms_id),
      ])].filter(Boolean);

      const [reservationStatuses, notifiedPins, pinUsage, remoteUsage] = await Promise.all([
        this.queryReservationStatuses(allPmsIds),
        this.queryPinsForPmsIds(allPmsIds),
        this.queryPhysicalPinUsage(allPmsIds),
        this.queryRemoteUsage(allPmsIds),
      ]);

      const html = this.buildHtml(
        dateLabel, stats,
        invitations, boardingPasses, unlocks,
        reservationStatuses, notifiedPins, pinUsage, remoteUsage,
        lockUsage, lockDayLabel
      );
      const text = this.buildText(
        dateLabel, stats,
        invitations, boardingPasses, unlocks,
        reservationStatuses, notifiedPins, pinUsage, remoteUsage,
        lockUsage, lockDayLabel
      );

      await this.sendEmail(html, text, dateLabel);

      await this.storage.createLog({
        level: "info",
        message: `Daily combined report sent for ${dateLabel}`,
        source: "automation",
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[DailyReport] Failed to send report:", msg);
      await this.storage.createLog({
        level: "error",
        message: `Daily report failed: ${msg}`,
        source: "automation",
      });
    }
  }

  // ─── User statistics queries ───────────────────────────────────────

  private async gatherStats(from: string, to: string) {
    const { pool } = await import("./db");

    // 1. Current in-house guests (Checked-in, not yet departed) with mapped room
    const inHouse = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM reservations r
       WHERE r.status = 'Checked-in'
         AND r.departure > NOW()
         AND r.room_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM room_lock_assignments rla
           JOIN lock_devices ld ON ld.id = rla.lock_device_id
           WHERE rla.room_id = r.room_id AND ld.lock_type = 'room'
         )`
    );

    // 2. In-house with active PIN
    const inHouseWithPin = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM reservations r
       WHERE r.status = 'Checked-in'
         AND r.departure > NOW()
         AND r.generated_pin IS NOT NULL
         AND r.room_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM room_lock_assignments rla
           JOIN lock_devices ld ON ld.id = rla.lock_device_id
           WHERE rla.room_id = r.room_id AND ld.lock_type = 'room'
         )`
    );

    // 3. Check-ins last 24h (by our system)
    const checkInsViaUs = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM logs l
       WHERE l.timestamp >= $1 AND l.timestamp < $2
         AND l.message ILIKE '%Check-in completed%'`,
      [from, to]
    );

    // 4. Check-ins last 24h (via MEWS/kiosk)
    const checkInsViaMews = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM reservations r
       WHERE r.status = 'Checked-in'
         AND r.pms_checkin_source = 'mews'
         AND r.updated_at >= $1 AND r.updated_at < $2`,
      [from, to]
    );

    // 5. Pre-check-in invitations sent
    const preCheckins = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM logs l
       WHERE l.timestamp >= $1 AND l.timestamp < $2
         AND l.message ILIKE '%Pre-checkin sent%'`,
      [from, to]
    );

    // 6. Boarding passes / digital keys sent
    const boardingPasses = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM logs l
       WHERE l.timestamp >= $1 AND l.timestamp < $2
         AND l.message ILIKE '%Digital key sent via%'`,
      [from, to]
    );

    // 7. Remote unlocks (by guest)
    const unlocks = await pool.query<{ count: string; unique_guests: string }>(
      `SELECT COUNT(*)::text AS count,
              COUNT(DISTINCT l.reservation_id)::text AS unique_guests
       FROM logs l
       WHERE l.timestamp >= $1 AND l.timestamp < $2
         AND l.message ILIKE '%Remote unlock triggered by guest%'`,
      [from, to]
    );

    // 8. PINs generated
    const pinsGenerated = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pins
       WHERE created_at >= $1 AND created_at < $2`,
      [from, to]
    );

    // 9. New reservations created (in our DB)
    const newReservations = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM reservations
       WHERE created_at >= $1 AND created_at < $2`,
      [from, to]
    );

    // 10. Active reservations today (arrivals)
    const arrivalsToday = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM reservations r
       WHERE r.arrival::date = CURRENT_DATE
         AND r.status IN ('Confirmed', 'Checked-in')
         AND r.room_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM room_lock_assignments rla
           JOIN lock_devices ld ON ld.id = rla.lock_device_id
           WHERE rla.room_id = r.room_id AND ld.lock_type = 'room'
         )`
    );

    // 11. Departures today
    const departuresToday = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM reservations r
       WHERE r.departure::date = CURRENT_DATE
         AND r.status IN ('Checked-in', 'Checked-out')
         AND r.room_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM room_lock_assignments rla
           JOIN lock_devices ld ON ld.id = rla.lock_device_id
           WHERE rla.room_id = r.room_id AND ld.lock_type = 'room'
         )`
    );

    // 12a. Today's arrivals funnel (mapped rooms)
    const arrivalFunnelToday = await pool.query<{
      total: string;
      pre_checkin_sent: string;
      boarding_sent: string;
    }>(
      `SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE r.pre_checkin_email_sent = true)::text AS pre_checkin_sent,
        COUNT(*) FILTER (WHERE r.notification_sent = true OR r.pre_checkin_status = 'code_sent')::text AS boarding_sent
       FROM reservations r
       WHERE r.arrival::date = CURRENT_DATE
         AND r.status IN ('Confirmed', 'Checked-in')
         AND r.room_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM room_lock_assignments rla
           JOIN lock_devices ld ON ld.id = rla.lock_device_id
           WHERE rla.room_id = r.room_id AND ld.lock_type = 'room'
         )`
    );

    // 12b. Yesterday's arrivals funnel (mapped rooms)
    const arrivalFunnelYesterday = await pool.query<{
      total: string;
      pre_checkin_sent: string;
      boarding_sent: string;
    }>(
      `SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE r.pre_checkin_email_sent = true)::text AS pre_checkin_sent,
        COUNT(*) FILTER (WHERE r.notification_sent = true OR r.pre_checkin_status = 'code_sent')::text AS boarding_sent
       FROM reservations r
       WHERE r.arrival::date = CURRENT_DATE - 1
         AND r.status IN ('Confirmed', 'Checked-in', 'Checked-out')
         AND r.room_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM room_lock_assignments rla
           JOIN lock_devices ld ON ld.id = rla.lock_device_id
           WHERE rla.room_id = r.room_id AND ld.lock_type = 'room'
         )`
    );

    // 12. Errors / failures
    const errors = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM logs
       WHERE timestamp >= $1 AND timestamp < $2
         AND level = 'error'`,
      [from, to]
    );

    // 13. Top 5 unlock users
    const topUnlockers = await pool.query<{
      first_name: string;
      last_name: string;
      room: string | null;
      unlock_count: string;
    }>(
      `SELECT r.first_name, r.last_name, r.room, COUNT(*)::text AS unlock_count
       FROM logs l
       JOIN reservations r ON r.id = l.reservation_id
       WHERE l.timestamp >= $1 AND l.timestamp < $2
         AND l.message ILIKE '%Remote unlock triggered by guest%'
       GROUP BY r.id, r.first_name, r.last_name, r.room
       ORDER BY COUNT(*) DESC
       LIMIT 5`,
      [from, to]
    );

    // 14. Adoption: of in-house guests with boarding pass sent,
    // how many used PIN code vs remote unlock vs any method?
    const adoption = await pool.query<{
      boarding_sent: string;
      used_pin: string;
      used_remote: string;
      used_both: string;
      used_any: string;
    }>(
      `WITH in_house AS (
         SELECT r.id FROM reservations r
         WHERE r.status = 'Checked-in'
           AND r.departure > NOW()
           AND r.room_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM room_lock_assignments rla
             JOIN lock_devices ld ON ld.id = rla.lock_device_id
             WHERE rla.room_id = r.room_id AND ld.lock_type = 'room'
           )
       ),
       sent AS (
         SELECT r.id AS rid FROM reservations r
         WHERE r.id IN (SELECT id FROM in_house)
           AND (r.notification_sent = true OR r.pre_checkin_status = 'code_sent')
       ),
       used_pin AS (
         SELECT DISTINCT l.reservation_id AS rid FROM logs l
         WHERE l.reservation_id IN (SELECT rid FROM sent)
           AND l.message ILIKE '%first used via lock%'
       ),
       used_remote AS (
         SELECT DISTINCT l.reservation_id AS rid FROM logs l
         WHERE l.reservation_id IN (SELECT rid FROM sent)
           AND l.message ILIKE '%Remote unlock triggered by guest%'
       )
       SELECT
         (SELECT COUNT(*)::text FROM sent) AS boarding_sent,
         (SELECT COUNT(*)::text FROM used_pin) AS used_pin,
         (SELECT COUNT(*)::text FROM used_remote) AS used_remote,
         (SELECT COUNT(*)::text FROM (SELECT rid FROM used_pin INTERSECT SELECT rid FROM used_remote) x) AS used_both,
         (SELECT COUNT(*)::text FROM (SELECT rid FROM used_pin UNION SELECT rid FROM used_remote) x) AS used_any`
    );

    return {
      inHouse: parseInt(inHouse.rows[0]?.count || "0"),
      inHouseWithPin: parseInt(inHouseWithPin.rows[0]?.count || "0"),
      checkInsViaUs: parseInt(checkInsViaUs.rows[0]?.count || "0"),
      checkInsViaMews: parseInt(checkInsViaMews.rows[0]?.count || "0"),
      preCheckins: parseInt(preCheckins.rows[0]?.count || "0"),
      boardingPasses: parseInt(boardingPasses.rows[0]?.count || "0"),
      unlocksTotal: parseInt(unlocks.rows[0]?.count || "0"),
      unlocksUniqueGuests: parseInt(unlocks.rows[0]?.unique_guests || "0"),
      pinsGenerated: parseInt(pinsGenerated.rows[0]?.count || "0"),
      newReservations: parseInt(newReservations.rows[0]?.count || "0"),
      arrivalsToday: parseInt(arrivalsToday.rows[0]?.count || "0"),
      departuresToday: parseInt(departuresToday.rows[0]?.count || "0"),
      errors: parseInt(errors.rows[0]?.count || "0"),
      topUnlockers: topUnlockers.rows.map((r) => ({
        name: `${r.first_name} ${r.last_name}`,
        room: r.room || "—",
        count: parseInt(r.unlock_count),
      })),
      boardingSent: parseInt(adoption.rows[0]?.boarding_sent || "0"),
      usedPin: parseInt(adoption.rows[0]?.used_pin || "0"),
      usedRemote: parseInt(adoption.rows[0]?.used_remote || "0"),
      usedBoth: parseInt(adoption.rows[0]?.used_both || "0"),
      usedAny: parseInt(adoption.rows[0]?.used_any || "0"),
      arrivalFunnelToday: {
        total: parseInt(arrivalFunnelToday.rows[0]?.total || "0"),
        preCheckinSent: parseInt(arrivalFunnelToday.rows[0]?.pre_checkin_sent || "0"),
        boardingSent: parseInt(arrivalFunnelToday.rows[0]?.boarding_sent || "0"),
      },
      arrivalFunnelYesterday: {
        total: parseInt(arrivalFunnelYesterday.rows[0]?.total || "0"),
        preCheckinSent: parseInt(arrivalFunnelYesterday.rows[0]?.pre_checkin_sent || "0"),
        boardingSent: parseInt(arrivalFunnelYesterday.rows[0]?.boarding_sent || "0"),
      },
    };
  }

  // ─── Activity report queries (from former DailyReportScheduler) ────

  private async queryInvitations(from: string, to: string) {
    const { pool } = await import("./db");
    const result = await pool.query<{
      timestamp: Date;
      pms_id: string;
      first_name: string;
      last_name: string;
      arrival: Date;
      created_at: Date;
      metadata: any;
    }>(
      `SELECT l.timestamp, r.pms_id, r.first_name, r.last_name, r.arrival, r.created_at, l.metadata
       FROM logs l
       LEFT JOIN reservations r ON r.id = l.reservation_id
       WHERE l.timestamp >= $1 AND l.timestamp < $2
         AND l.message ILIKE '%Pre-check-in sent%'
         AND r.room_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM room_lock_assignments rla WHERE rla.room_id = r.room_id)
       ORDER BY l.timestamp ASC`,
      [from, to]
    );
    return result.rows;
  }

  private async queryBoardingPasses(from: string, to: string) {
    const { pool } = await import("./db");
    const result = await pool.query<{
      timestamp: Date;
      pms_id: string;
      first_name: string;
      last_name: string;
      arrival: Date;
      created_at: Date;
      message: string;
      metadata: any;
    }>(
      `SELECT l.timestamp, r.pms_id, r.first_name, r.last_name, r.arrival, r.created_at, l.message, l.metadata
       FROM logs l
       LEFT JOIN reservations r ON r.id = l.reservation_id
       WHERE l.timestamp >= $1 AND l.timestamp < $2
         AND l.message ILIKE '%Digital key sent via%'
         AND r.room_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM room_lock_assignments rla WHERE rla.room_id = r.room_id)
       ORDER BY l.timestamp ASC`,
      [from, to]
    );
    return result.rows;
  }

  private async queryUnlocks(from: string, to: string) {
    const { pool } = await import("./db");
    const result = await pool.query<{
      pms_id: string;
      first_name: string;
      last_name: string;
      count: string;
      locks: string;
    }>(
      `SELECT r.pms_id, r.first_name, r.last_name,
              COUNT(*) AS count,
              STRING_AGG(DISTINCT (l.metadata->>'lockName'), ', ') AS locks
       FROM logs l
       LEFT JOIN reservations r ON r.id = l.reservation_id
       WHERE l.timestamp >= $1 AND l.timestamp < $2
         AND l.message ILIKE '%Remote unlock triggered by guest%'
         AND r.room_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM room_lock_assignments rla WHERE rla.room_id = r.room_id)
       GROUP BY r.pms_id, r.first_name, r.last_name`,
      [from, to]
    );
    return result.rows;
  }

  private async queryReservationStatuses(pmsIds: string[]) {
    if (pmsIds.length === 0) return new Map<string, { status: string; checkinSource: string | null; room: string | null; arrival: Date | null; createdAt: Date | null }>();
    const { pool } = await import("./db");
    const placeholders = pmsIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await pool.query<{
      pms_id: string;
      status: string;
      pms_checkin_source: string | null;
      room: string | null;
      arrival: Date | null;
      created_at: Date | null;
    }>(
      `SELECT pms_id, status, pms_checkin_source, room, arrival, created_at
       FROM reservations
       WHERE pms_id IN (${placeholders})`,
      pmsIds
    );
    const map = new Map<string, { status: string; checkinSource: string | null; room: string | null; arrival: Date | null; createdAt: Date | null }>();
    for (const row of result.rows) {
      map.set(row.pms_id, {
        status: row.status,
        checkinSource: row.pms_checkin_source,
        room: row.room,
        arrival: row.arrival,
        createdAt: row.created_at,
      });
    }
    return map;
  }

  private async queryPinsForPmsIds(pmsIds: string[]) {
    if (pmsIds.length === 0) return [];
    const { pool } = await import("./db");
    const placeholders = pmsIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await pool.query<{
      pms_id: string;
      first_name: string;
      last_name: string;
      room: string | null;
      arrival: Date | null;
      created_at: Date | null;
      code: string;
      status: string;
      activated_at: Date | null;
      valid_from: Date;
      room_lock_key_ids: any;
      common_area_key_ids: any;
      notification_sent: boolean;
      pre_checkin_status: string | null;
      pre_checkin_email_sent: boolean;
    }>(
      `SELECT r.pms_id, r.first_name, r.last_name, r.room, r.arrival, r.created_at,
              p.code, p.status, p.activated_at, p.valid_from,
              p.room_lock_key_ids, p.common_area_key_ids,
              r.notification_sent, r.pre_checkin_status, r.pre_checkin_email_sent
       FROM pins p
       JOIN reservations r ON r.id = p.reservation_id
       WHERE r.pms_id IN (${placeholders})
         AND p.status IN ('pending', 'active')
       ORDER BY p.valid_from ASC, r.last_name ASC`,
      pmsIds
    );
    return result.rows;
  }

  private async queryPhysicalPinUsage(pmsIds: string[]): Promise<Set<string>> {
    if (pmsIds.length === 0) return new Set();
    const { pool } = await import("./db");
    const placeholders = pmsIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await pool.query<{ pms_id: string }>(
      `SELECT DISTINCT r.pms_id FROM logs l
       JOIN reservations r ON r.id = l.reservation_id
       WHERE r.pms_id IN (${placeholders})
         AND l.message ILIKE '%first used via lock%'`,
      pmsIds
    );
    return new Set(result.rows.map((r) => r.pms_id));
  }

  private async queryRemoteUsage(pmsIds: string[]): Promise<Set<string>> {
    if (pmsIds.length === 0) return new Set();
    const { pool } = await import("./db");
    const placeholders = pmsIds.map((_, i) => `$${i + 1}`).join(", ");
    const result = await pool.query<{ pms_id: string }>(
      `SELECT DISTINCT r.pms_id FROM logs l
       JOIN reservations r ON r.id = l.reservation_id
       WHERE r.pms_id IN (${placeholders})
         AND l.message ILIKE '%Remote unlock triggered by guest%'`,
      pmsIds
    );
    return new Set(result.rows.map((r) => r.pms_id));
  }

  // ─── Per-room lock usage (TTLock) ──────────────────────────────────

  // Classification (data-driven, matches manual TTLock analysis):
  //   failed  = unlock not successful
  //   pin     = a keypad code was entered (keyboardPwd present)
  //   ekey    = account holder (email username) opened via app/eKey/gateway
  //   sys     = no user / no code (auto-lock, passage, sensor events)
  private async queryRoomLockUsage(
    startMs: number,
    endMs: number
  ): Promise<RoomLockUsage[]> {
    try {
      const { createOwnerClient } = await import("./ttlock-client");
      const ttlock = await createOwnerClient();
      const rooms = await this.storage.getAllRooms();

      const out: RoomLockUsage[] = [];
      for (const room of rooms) {
        const assignments = await this.storage.getRoomLockAssignments(room.id);
        const ttlockIds: string[] = [];
        for (const a of assignments) {
          const id = a.lockDevice?.ttlockId;
          if (id && !ttlockIds.includes(id)) ttlockIds.push(id);
        }
        if (ttlockIds.length === 0) continue;

        let pin = 0, ekey = 0, sys = 0, fail = 0;
        for (const lockId of ttlockIds) {
          try {
            for (let page = 1; page <= 20; page++) {
              const records = await ttlock.getUnlockRecords(lockId, {
                startDate: startMs,
                endDate: endMs,
                pageNo: page,
                pageSize: 100,
              });
              for (const rec of records) {
                const ms = rec.lockDate instanceof Date
                  ? rec.lockDate.getTime()
                  : new Date(rec.lockDate).getTime();
                if (ms < startMs || ms >= endMs) continue;
                if (!rec.success) { fail++; continue; }
                if (rec.keyboardPwd) { pin++; }
                else if (rec.username && rec.username.includes("@")) { ekey++; }
                else { sys++; }
              }
              if (records.length < 100) break;
            }
          } catch (err) {
            console.error(
              `[DailyReport] Lock usage fetch failed for lock ${lockId}:`,
              err instanceof Error ? err.message : String(err)
            );
          }
        }

        if (pin + ekey + sys + fail > 0) {
          out.push({ room: room.name, pin, ekey, sys, fail });
        }
      }

      out.sort((a, b) =>
        a.room.localeCompare(b.room, undefined, { numeric: true })
      );
      return out;
    } catch (err) {
      console.error(
        "[DailyReport] Room lock usage section skipped:",
        err instanceof Error ? err.message : String(err)
      );
      return [];
    }
  }

  // ─── Formatting helpers ────────────────────────────────────────────

  private toLocalTime(ts: Date | string): string {
    return DateTime.fromJSDate(new Date(ts)).setZone(TIMEZONE).toFormat("HH:mm");
  }

  private toLocalDate(ts: Date | string): string {
    return DateTime.fromJSDate(new Date(ts)).setZone(TIMEZONE).toFormat("dd/MM/yyyy");
  }

  private checkinLabel(pmsId: string, statuses: Map<string, any>): string {
    const s = statuses.get(pmsId);
    if (!s) return "—";
    if (s.checkinSource === "mews") return "Kiosk / Reception (MEWS)";
    return "Vores check-in";
  }

  private mewsStatusLabel(pmsId: string, statuses: Map<string, any>): string {
    const s = statuses.get(pmsId);
    if (!s) return "—";
    const colors: Record<string, string> = {
      "Confirmed": "#c8a000",
      "Checked-in": "#2e7d32",
      "Checked-out": "#555",
      "Cancelled": "#cc352a",
    };
    const c = colors[s.status] ?? "#333";
    return `<span style="color:${c};font-weight:600">${s.status}</span>`;
  }

  // ─── Combined HTML ─────────────────────────────────────────────────

  private buildHtml(
    dateLabel: string,
    s: Awaited<ReturnType<UserStatsScheduler["gatherStats"]>>,
    invitations: any[],
    boardingPasses: any[],
    unlocks: any[],
    statuses: Map<string, any>,
    todayPins: any[],
    pinUsage: Set<string>,
    remoteUsage: Set<string>,
    lockUsage: RoomLockUsage[],
    lockDayLabel: string
  ): string {
    // ── User statistics section ──
    const pct = (num: number, denom: number) =>
      denom > 0 ? Math.round((num / denom) * 100) : 0;
    const anyPct = pct(s.usedAny, s.boardingSent);
    const pinPct = pct(s.usedPin, s.boardingSent);
    const remotePct = pct(s.usedRemote, s.boardingSent);
    const onlyPin = s.usedPin - s.usedBoth;
    const onlyRemote = s.usedRemote - s.usedBoth;

    const stat = (label: string, value: string | number, sub?: string) => `
      <div style="background:#f8f8f8;border-left:3px solid #cc352a;padding:14px 18px;margin-bottom:10px">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#666">${label}</div>
        <div style="font-size:24px;font-weight:700;color:#232321;margin-top:4px">${value}</div>
        ${sub ? `<div style="font-size:12px;color:#888;margin-top:2px">${sub}</div>` : ""}
      </div>`;

    const topUnlockersHtml = s.topUnlockers.length > 0
      ? `<table style="width:100%;border-collapse:collapse;margin-top:8px">
          <tr>
            <th style="padding:8px 10px;background:#f4f4f4;text-align:left;font-size:13px;color:#555">Guest</th>
            <th style="padding:8px 10px;background:#f4f4f4;text-align:left;font-size:13px;color:#555">Room</th>
            <th style="padding:8px 10px;background:#f4f4f4;text-align:right;font-size:13px;color:#555">Unlocks</th>
          </tr>
          ${s.topUnlockers.map((u) => `
            <tr>
              <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:14px">${u.name}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:14px">${u.room}</td>
              <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:14px;text-align:right;font-weight:600">${u.count}</td>
            </tr>`).join("")}
         </table>`
      : `<p style="color:#999;font-style:italic;font-size:14px">No unlocks recorded</p>`;

    // ── Activity tables section ──
    const unlockMap = new Map<string, { count: number; locks: string }>();
    for (const u of unlocks) {
      if (u.pms_id) unlockMap.set(u.pms_id, { count: parseInt(u.count), locks: u.locks ?? "—" });
    }

    const row = (cells: string[]) =>
      `<tr>${cells.map((c) => `<td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:14px">${c}</td>`).join("")}</tr>`;

    const th = (cells: string[]) =>
      `<tr>${cells.map((c) => `<th style="padding:8px 10px;background:#f4f4f4;text-align:left;font-size:13px;color:#555">${c}</th>`).join("")}</tr>`;

    const table = (headers: string[], rows: string[]) =>
      `<table style="width:100%;border-collapse:collapse;margin-bottom:30px">
        ${th(headers)}
        ${rows.length ? rows.join("") : `<tr><td colspan="${headers.length}" style="padding:12px 10px;color:#999;font-style:italic;font-size:14px">Ingen</td></tr>`}
       </table>`;

    const invRows = invitations.map((r) => {
      const meta = typeof r.metadata === "string" ? JSON.parse(r.metadata || "{}") : (r.metadata ?? {});
      const status = statuses.get(r.pms_id);
      return row([
        this.toLocalTime(r.timestamp),
        `${r.first_name} ${r.last_name}`,
        status?.room ?? "—",
        r.arrival ? this.toLocalDate(r.arrival) : (status?.arrival ? this.toLocalDate(status.arrival) : "—"),
        r.created_at ? this.toLocalDate(r.created_at) : (status?.createdAt ? this.toLocalDate(status.createdAt) : "—"),
        meta.testMode ? `<span style="color:#999">TEST → ${meta.email}</span>` : (meta.email ?? "—"),
        this.mewsStatusLabel(r.pms_id, statuses),
      ]);
    });

    const bpRows = boardingPasses.map((r) => {
      const meta = typeof r.metadata === "string" ? JSON.parse(r.metadata || "{}") : (r.metadata ?? {});
      const unlockInfo = unlockMap.get(r.pms_id);
      const unlockCell = unlockInfo
        ? `<span style="color:#2e7d32;font-weight:600">✓ ${unlockInfo.count}× (${unlockInfo.locks})</span>`
        : "Nej";
      const status = statuses.get(r.pms_id);
      return row([
        this.toLocalTime(r.timestamp),
        `${r.first_name} ${r.last_name}`,
        status?.room ?? "—",
        r.arrival ? this.toLocalDate(r.arrival) : (status?.arrival ? this.toLocalDate(status.arrival) : "—"),
        r.created_at ? this.toLocalDate(r.created_at) : (status?.createdAt ? this.toLocalDate(status.createdAt) : "—"),
        this.checkinLabel(r.pms_id, statuses),
        meta.testMode ? `<span style="color:#999">TEST → ${meta.email}</span>` : (meta.email ?? "—"),
        unlockCell,
        this.mewsStatusLabel(r.pms_id, statuses),
      ]);
    });

    const pinRows = todayPins.map((p) => {
      const roomKeys: any[] = Array.isArray(p.room_lock_key_ids) ? p.room_lock_key_ids : [];
      const areaKeys: any[] = Array.isArray(p.common_area_key_ids) ? p.common_area_key_ids : [];
      const allKeys = [...roomKeys, ...areaKeys];
      // "existing" means PIN got -3007 (already exists on lock) — count as pushed
      const pushedCount = allKeys.filter((k: any) => k.keyId).length;
      const totalLocks = allKeys.length;

      // totalLocks=0 + pending means PIN not yet activated (arrays are empty before push)
      // totalLocks=0 + active would be genuinely no locks assigned
      const ttlockCell = totalLocks === 0 && p.status === "active"
        ? `<span style="color:#cc352a">Ingen låse tildelt</span>`
        : totalLocks === 0
        ? `<span style="color:#c8a000">Afventer aktivering kl. 14:00</span>`
        : pushedCount === totalLocks
        ? `<span style="color:#2e7d32;font-weight:600">✓ ${pushedCount}/${totalLocks} låse</span>`
        : pushedCount > 0
        ? `<span style="color:#c8a000;font-weight:600">Delvist ${pushedCount}/${totalLocks}</span>`
        : `<span style="color:#c8a000">Afventer aktivering kl. 14:00</span>`;

      const pinStatusCell = p.status === "active"
        ? `<span style="color:#2e7d32;font-weight:600">Aktiv</span>`
        : `<span style="color:#c8a000">Afventer</span>`;

      const bpCell = p.notification_sent || p.pre_checkin_status === "code_sent"
        ? `<span style="color:#2e7d32;font-weight:600">✓ Sendt</span>`
        : p.pre_checkin_email_sent
        ? `<span style="color:#c8a000">Pre-checkin sendt</span>`
        : `<span style="color:#999">Ikke sendt</span>`;

      const activatedCell = p.activated_at
        ? this.toLocalTime(p.activated_at)
        : `<span style="color:#999">—</span>`;

      const usedPinCell = pinUsage.has(p.pms_id)
        ? `<span style="color:#2e7d32;font-weight:600">✓</span>`
        : `<span style="color:#999">—</span>`;
      const usedRemoteCell = remoteUsage.has(p.pms_id)
        ? `<span style="color:#2e7d32;font-weight:600">✓</span>`
        : `<span style="color:#999">—</span>`;

      return row([
        `${p.first_name} ${p.last_name}`,
        p.room ?? "—",
        p.arrival ? this.toLocalDate(p.arrival) : "—",
        p.created_at ? this.toLocalDate(p.created_at) : "—",
        `<code style="font-family:monospace;font-size:14px">${p.code}</code>`,
        pinStatusCell,
        ttlockCell,
        activatedCell,
        usedPinCell,
        usedRemoteCell,
        bpCell,
      ]);
    });

    const sectionHead = (title: string) =>
      `<h2 style="font-size:16px;font-weight:700;color:#232321;margin:28px 0 12px;padding-bottom:6px;border-bottom:2px solid #cc352a">${title}</h2>`;

    const pinPctStr = s.inHouse > 0 ? Math.round((s.inHouseWithPin / s.inHouse) * 100) : 0;

    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:900px;margin:0 auto;padding:20px;color:#232321;background:#fff">

  <table width="100%" cellpadding="0" cellspacing="0" style="border-bottom:3px solid #cc352a;padding-bottom:12px;margin-bottom:24px">
    <tr><td>
      <h1 style="margin:0;font-size:22px;color:#cc352a">DreamBoks — Daglig rapport</h1>
      <p style="margin:4px 0 0;color:#666;font-size:14px">${dateLabel} kl. ${SEND_HOUR_LABEL} – i dag kl. ${SEND_HOUR_LABEL}</p>
    </td></tr>
  </table>

  <!-- ═══ BRUGERSTATISTIK ═══ -->

  ${sectionHead("Nuværende status")}
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px">
    <tr>
      <td width="50%" style="padding:0 5px 10px 0;vertical-align:top">${stat("In-house gæster", s.inHouse, "med mappet rum")}</td>
      <td width="50%" style="padding:0 0 10px 5px;vertical-align:top">${stat("Med aktiv PIN", s.inHouseWithPin, `${pinPctStr}% af in-house`)}</td>
    </tr>
    <tr>
      <td width="50%" style="padding:0 5px 10px 0;vertical-align:top">${stat("Ankomster i dag", s.arrivalsToday)}</td>
      <td width="50%" style="padding:0 0 10px 5px;vertical-align:top">${stat("Afrejser i dag", s.departuresToday)}</td>
    </tr>
  </table>

  ${sectionHead("Ankomst-funnel")}
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
    <tr>
      <th style="padding:8px 10px;background:#f4f4f4;text-align:left;font-size:13px;color:#555"></th>
      <th style="padding:8px 10px;background:#f4f4f4;text-align:right;font-size:13px;color:#555">I dag</th>
      <th style="padding:8px 10px;background:#f4f4f4;text-align:right;font-size:13px;color:#555">I går</th>
    </tr>
    <tr>
      <td style="padding:10px 10px;border-bottom:1px solid #eee;font-size:14px;font-weight:600">Ankomster (mappede rum)</td>
      <td style="padding:10px 10px;border-bottom:1px solid #eee;font-size:18px;font-weight:700;text-align:right;color:#232321">${s.arrivalFunnelToday.total}</td>
      <td style="padding:10px 10px;border-bottom:1px solid #eee;font-size:18px;font-weight:700;text-align:right;color:#232321">${s.arrivalFunnelYesterday.total}</td>
    </tr>
    <tr>
      <td style="padding:10px 10px 10px 24px;border-bottom:1px solid #eee;font-size:14px;color:#444">↳ Pre-checkin mail sendt</td>
      <td style="padding:10px 10px;border-bottom:1px solid #eee;font-size:16px;font-weight:600;text-align:right;color:${s.arrivalFunnelToday.preCheckinSent === s.arrivalFunnelToday.total && s.arrivalFunnelToday.total > 0 ? '#2e7d32' : '#c8a000'}">${s.arrivalFunnelToday.preCheckinSent} / ${s.arrivalFunnelToday.total}</td>
      <td style="padding:10px 10px;border-bottom:1px solid #eee;font-size:16px;font-weight:600;text-align:right;color:${s.arrivalFunnelYesterday.preCheckinSent === s.arrivalFunnelYesterday.total && s.arrivalFunnelYesterday.total > 0 ? '#2e7d32' : '#c8a000'}">${s.arrivalFunnelYesterday.preCheckinSent} / ${s.arrivalFunnelYesterday.total}</td>
    </tr>
    <tr>
      <td style="padding:10px 10px 10px 24px;font-size:14px;color:#444">↳ Boarding card sendt</td>
      <td style="padding:10px 10px;font-size:16px;font-weight:600;text-align:right;color:${s.arrivalFunnelToday.boardingSent === s.arrivalFunnelToday.total && s.arrivalFunnelToday.total > 0 ? '#2e7d32' : s.arrivalFunnelToday.boardingSent > 0 ? '#c8a000' : '#999'}">${s.arrivalFunnelToday.boardingSent} / ${s.arrivalFunnelToday.total}</td>
      <td style="padding:10px 10px;font-size:16px;font-weight:600;text-align:right;color:${s.arrivalFunnelYesterday.boardingSent === s.arrivalFunnelYesterday.total && s.arrivalFunnelYesterday.total > 0 ? '#2e7d32' : s.arrivalFunnelYesterday.boardingSent > 0 ? '#c8a000' : '#999'}">${s.arrivalFunnelYesterday.boardingSent} / ${s.arrivalFunnelYesterday.total}</td>
    </tr>
  </table>

  ${sectionHead(`Aktivitet (${dateLabel} ${SEND_HOUR_LABEL} – i dag ${SEND_HOUR_LABEL})`)}
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:10px">
    <tr>
      <td width="50%" style="padding:0 5px 10px 0;vertical-align:top">${stat("Pre-check-in sendt", s.preCheckins)}</td>
      <td width="50%" style="padding:0 0 10px 5px;vertical-align:top">${stat("Digital nøgle sendt", s.boardingPasses)}</td>
    </tr>
    <tr>
      <td width="50%" style="padding:0 5px 10px 0;vertical-align:top">${stat("Check-in via os", s.checkInsViaUs)}</td>
      <td width="50%" style="padding:0 0 10px 5px;vertical-align:top">${stat("Check-in via MEWS", s.checkInsViaMews)}</td>
    </tr>
    <tr>
      <td width="50%" style="padding:0 5px 10px 0;vertical-align:top">${stat("PIN-koder genereret", s.pinsGenerated)}</td>
      <td width="50%" style="padding:0 0 10px 5px;vertical-align:top">${stat("Nye reservationer", s.newReservations)}</td>
    </tr>
    <tr>
      <td width="50%" style="padding:0 5px 10px 0;vertical-align:top">${stat("Remote unlocks", s.unlocksTotal, `fra ${s.unlocksUniqueGuests} gæster`)}</td>
      <td width="50%" style="padding:0 0 10px 5px;vertical-align:top">${stat("Fejl i logs", s.errors, s.errors > 0 ? "tjek log-siden" : "alt ok")}</td>
    </tr>
  </table>

  ${sectionHead("Digital nøgle — adoption")}
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px">
    <tr><td style="background:#f8f8f8;border-left:3px solid #c8d5e9;padding:16px 20px">
      <div style="font-size:14px;color:#555;margin-bottom:6px">Af ${s.boardingSent} in-house gæster med digital nøgle:</div>
      <div style="font-size:28px;font-weight:700;color:#cc352a">${s.usedAny} / ${s.boardingSent} (${anyPct}%)</div>
      <div style="font-size:13px;color:#666;margin-top:6px">har åbnet deres dør mindst én gang (PIN eller remote)</div>
    </td></tr>
  </table>
  <table style="width:100%;border-collapse:collapse">
    <tr>
      <th style="padding:8px 10px;background:#f4f4f4;text-align:left;font-size:13px;color:#555">Metode</th>
      <th style="padding:8px 10px;background:#f4f4f4;text-align:right;font-size:13px;color:#555">Gæster</th>
      <th style="padding:8px 10px;background:#f4f4f4;text-align:right;font-size:13px;color:#555">Andel</th>
    </tr>
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:14px">Indtastet PIN-kode på lås</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:14px;text-align:right;font-weight:600">${s.usedPin}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:14px;text-align:right;color:#666">${pinPct}%</td>
    </tr>
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:14px">Remote unlock via digital nøgle</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:14px;text-align:right;font-weight:600">${s.usedRemote}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:14px;text-align:right;color:#666">${remotePct}%</td>
    </tr>
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;color:#888;padding-left:24px">— kun PIN</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;color:#888;text-align:right">${onlyPin}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;color:#888;text-align:right">—</td>
    </tr>
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;color:#888;padding-left:24px">— kun remote</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;color:#888;text-align:right">${onlyRemote}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;color:#888;text-align:right">—</td>
    </tr>
    <tr>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;color:#888;padding-left:24px">— begge metoder</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;color:#888;text-align:right">${s.usedBoth}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;color:#888;text-align:right">—</td>
    </tr>
  </table>
  <p style="font-size:11px;color:#999;margin-top:6px;font-style:italic">PIN-brug måles ved daglig TTLock-polling kl. 01:00, så dagens PIN-aktiveringer vises først i morgen.</p>

  ${sectionHead("Top 5 mest aktive remote-brugere")}
  ${topUnlockersHtml}

  ${sectionHead(`Låsbrug pr. værelse — ${lockDayLabel} (00:00–24:00)`)}
  ${(() => {
    const tot = lockUsage.reduce(
      (acc, r) => ({
        pin: acc.pin + r.pin,
        ekey: acc.ekey + r.ekey,
        sys: acc.sys + r.sys,
        fail: acc.fail + r.fail,
      }),
      { pin: 0, ekey: 0, sys: 0, fail: 0 }
    );
    const numCell = (v: number) =>
      `<td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:14px;text-align:right">${v}</td>`;
    const bodyRows = lockUsage.map(
      (r) =>
        `<tr><td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:14px">${r.room}</td>${numCell(r.pin)}${numCell(r.ekey)}${numCell(r.sys)}${numCell(r.fail)}</tr>`
    );
    if (bodyRows.length === 0) {
      return `<p style="color:#999;font-style:italic;font-size:14px">Ingen låsdata tilgængelig (TTLock utilgængelig eller ingen aktivitet)</p>`;
    }
    return `<table style="width:100%;border-collapse:collapse;margin-bottom:8px">
      <tr>
        <th style="padding:8px 10px;background:#f4f4f4;text-align:left;font-size:13px;color:#555">Værelse</th>
        <th style="padding:8px 10px;background:#f4f4f4;text-align:right;font-size:13px;color:#555">PIN-kode</th>
        <th style="padding:8px 10px;background:#f4f4f4;text-align:right;font-size:13px;color:#555">Remote/eKey</th>
        <th style="padding:8px 10px;background:#f4f4f4;text-align:right;font-size:13px;color:#555">System</th>
        <th style="padding:8px 10px;background:#f4f4f4;text-align:right;font-size:13px;color:#555">Fejlede</th>
      </tr>
      ${bodyRows.join("")}
      <tr style="background:#faf3f2">
        <td style="padding:10px;font-size:14px;font-weight:700">I ALT</td>
        <td style="padding:10px;font-size:14px;font-weight:700;text-align:right">${tot.pin}</td>
        <td style="padding:10px;font-size:14px;font-weight:700;text-align:right">${tot.ekey}</td>
        <td style="padding:10px;font-size:14px;font-weight:700;text-align:right">${tot.sys}</td>
        <td style="padding:10px;font-size:14px;font-weight:700;text-align:right">${tot.fail}</td>
      </tr>
     </table>
     <p style="font-size:11px;color:#999;margin-top:6px;font-style:italic">Kilde: TTLock direkte. PIN = indtastet kode · Remote/eKey = app/eKey-konto · System = auto/sensor (rt46) · Fejlede = afvist forsøg.</p>`;
  })()}

  <!-- ═══ DETALJERET AKTIVITET ═══ -->

  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:36px;border-top:3px solid #cc352a">
    <tr><td style="padding-top:24px">
      <h2 style="font-size:18px;font-weight:700;color:#cc352a;margin:0 0 20px">Detaljeret aktivitet</h2>
    </td></tr>
  </table>

  ${sectionHead(`Pre-check-in invitationer sendt (${invitations.length})`)}
  ${table(
    ["Tidspunkt", "Gæst", "Rum", "Ankomst", "Booking dato", "Sendt til", "MEWS status"],
    invRows
  )}

  ${sectionHead(`Boarding pass / digital nøgle sendt (${boardingPasses.length})`)}
  ${table(
    ["Tidspunkt", "Gæst", "Rum", "Ankomst", "Booking dato", "Check-in via", "Sendt til", "Boarding pass brugt", "MEWS status"],
    bpRows
  )}

  ${sectionHead(`PIN aktivering — notificerede gæster (${todayPins.length})`)}
  ${table(
    ["Gæst", "Rum", "Ankomst", "Booking dato", "PIN", "Status", "TTLock", "Aktiveret kl.", "PIN brugt", "Remote brugt", "Boarding pass"],
    pinRows
  )}

  <p style="font-size:12px;color:#999;margin-top:30px;border-top:1px solid #eee;padding-top:12px">
    Automatisk rapport fra DreamBoksLock · ${DateTime.now().setZone(TIMEZONE).toFormat("dd/MM/yyyy HH:mm")} CET
  </p>
</body>
</html>`;
  }

  // ─── Combined plain text ───────────────────────────────────────────

  private buildText(
    dateLabel: string,
    s: Awaited<ReturnType<UserStatsScheduler["gatherStats"]>>,
    invitations: any[],
    boardingPasses: any[],
    unlocks: any[],
    statuses: Map<string, any>,
    todayPins: any[],
    pinUsage: Set<string>,
    remoteUsage: Set<string>,
    lockUsage: RoomLockUsage[],
    lockDayLabel: string
  ): string {
    const pct = (num: number, denom: number) =>
      denom > 0 ? Math.round((num / denom) * 100) : 0;
    const anyPct = pct(s.usedAny, s.boardingSent);
    const pinPct = pct(s.usedPin, s.boardingSent);
    const remotePct = pct(s.usedRemote, s.boardingSent);
    const onlyPin = s.usedPin - s.usedBoth;
    const onlyRemote = s.usedRemote - s.usedBoth;

    let out = `DreamBoks — Daglig rapport — ${dateLabel} kl. ${SEND_HOUR_LABEL} – i dag kl. ${SEND_HOUR_LABEL}\n\n`;

    // ── User statistics ──
    out += `═══ BRUGERSTATISTIK ═══\n\n`;

    out += `CURRENT STATUS\n`;
    out += `  In-house guests (mapped room):  ${s.inHouse}\n`;
    out += `  With active PIN:                ${s.inHouseWithPin}\n`;
    out += `  Arrivals today:                 ${s.arrivalsToday}\n`;
    out += `  Departures today:               ${s.departuresToday}\n\n`;

    out += `ANKOMST-FUNNEL\n`;
    out += `                                     I dag       I går\n`;
    out += `  Ankomster (mappede rum):            ${String(s.arrivalFunnelToday.total).padStart(4)}        ${String(s.arrivalFunnelYesterday.total).padStart(4)}\n`;
    out += `  ↳ Pre-checkin mail sendt:           ${String(s.arrivalFunnelToday.preCheckinSent).padStart(4)}        ${String(s.arrivalFunnelYesterday.preCheckinSent).padStart(4)}\n`;
    out += `  ↳ Boarding card sendt:              ${String(s.arrivalFunnelToday.boardingSent).padStart(4)}        ${String(s.arrivalFunnelYesterday.boardingSent).padStart(4)}\n\n`;

    out += `ACTIVITY (${dateLabel} ${SEND_HOUR_LABEL} – i dag ${SEND_HOUR_LABEL})\n`;
    out += `  Pre-check-in sent:              ${s.preCheckins}\n`;
    out += `  Digital key sent:               ${s.boardingPasses}\n`;
    out += `  Check-in via us:                ${s.checkInsViaUs}\n`;
    out += `  Check-in via MEWS:              ${s.checkInsViaMews}\n`;
    out += `  PINs generated:                 ${s.pinsGenerated}\n`;
    out += `  New reservations:               ${s.newReservations}\n`;
    out += `  Total unlocks:                  ${s.unlocksTotal} (${s.unlocksUniqueGuests} unique guests)\n`;
    out += `  Errors in logs:                 ${s.errors}\n\n`;

    out += `DIGITAL KEY ADOPTION (${s.boardingSent} in-house guests received a digital key)\n`;
    out += `  Opened door at all:             ${s.usedAny}/${s.boardingSent} (${anyPct}%)\n`;
    out += `  Used PIN code:                  ${s.usedPin}/${s.boardingSent} (${pinPct}%)\n`;
    out += `  Used remote button:             ${s.usedRemote}/${s.boardingSent} (${remotePct}%)\n`;
    out += `    — PIN only:                   ${onlyPin}\n`;
    out += `    — remote only:                ${onlyRemote}\n`;
    out += `    — both methods:               ${s.usedBoth}\n`;
    out += `  (PIN usage measured by daily TTLock poll at 01:00)\n\n`;

    if (s.topUnlockers.length > 0) {
      out += `TOP 5 MOST ACTIVE REMOTE USERS (unlocks)\n`;
      for (const u of s.topUnlockers) {
        out += `  ${u.count}x  ${u.name}  (room ${u.room})\n`;
      }
      out += `\n`;
    }

    // ── Per-room lock usage ──
    out += `LÅSBRUG PR. VÆRELSE — ${lockDayLabel} (00:00–24:00)\n`;
    if (lockUsage.length === 0) {
      out += `  Ingen låsdata tilgængelig (TTLock utilgængelig eller ingen aktivitet)\n\n`;
    } else {
      out += `  ${"Værelse".padEnd(12)} ${"PIN".padStart(6)} ${"Remote".padStart(8)} ${"System".padStart(8)} ${"Fejl".padStart(6)}\n`;
      const tot = { pin: 0, ekey: 0, sys: 0, fail: 0 };
      for (const r of lockUsage) {
        tot.pin += r.pin; tot.ekey += r.ekey; tot.sys += r.sys; tot.fail += r.fail;
        out += `  ${r.room.padEnd(12)} ${String(r.pin).padStart(6)} ${String(r.ekey).padStart(8)} ${String(r.sys).padStart(8)} ${String(r.fail).padStart(6)}\n`;
      }
      out += `  ${"I ALT".padEnd(12)} ${String(tot.pin).padStart(6)} ${String(tot.ekey).padStart(8)} ${String(tot.sys).padStart(8)} ${String(tot.fail).padStart(6)}\n`;
      out += `  (PIN = indtastet kode · Remote/eKey = app/eKey-konto · System = auto/sensor · Kilde: TTLock)\n\n`;
    }

    // ── Activity tables ──
    out += `═══ DETALJERET AKTIVITET ═══\n\n`;

    const unlockMap = new Map<string, number>();
    for (const u of unlocks) {
      if (u.pms_id) unlockMap.set(u.pms_id, parseInt(u.count));
    }

    out += `PRE-CHECK-IN INVITATIONER (${invitations.length})\n`;
    for (const r of invitations) {
      const st = statuses.get(r.pms_id);
      out += `  ${this.toLocalTime(r.timestamp)}  ${r.first_name} ${r.last_name}  Rum: ${st?.room ?? "—"}  MEWS: ${st?.status ?? "—"}\n`;
    }

    out += `\nBOARDING PASS SENDT (${boardingPasses.length})\n`;
    for (const r of boardingPasses) {
      const st = statuses.get(r.pms_id);
      const uc = unlockMap.get(r.pms_id);
      out += `  ${this.toLocalTime(r.timestamp)}  ${r.first_name} ${r.last_name}  Rum: ${st?.room ?? "—"}  ${this.checkinLabel(r.pms_id, statuses)}  Boarding pass brugt: ${uc ? `Ja (${uc}x)` : "Nej"}  MEWS: ${st?.status ?? "—"}\n`;
    }

    out += `\nPIN AKTIVERING — NOTIFICEREDE GÆSTER (${todayPins.length})\n`;
    for (const p of todayPins) {
      const allKeys = [
        ...(Array.isArray(p.room_lock_key_ids) ? p.room_lock_key_ids : []),
        ...(Array.isArray(p.common_area_key_ids) ? p.common_area_key_ids : []),
      ];
      const pushed = allKeys.filter((k: any) => k.keyId).length;
      const bp = p.notification_sent || p.pre_checkin_status === "code_sent" ? "Ja" : "Nej";
      const pin = pinUsage.has(p.pms_id) ? "✓" : "—";
      const remote = remoteUsage.has(p.pms_id) ? "✓" : "—";
      out += `  ${p.first_name} ${p.last_name}  Rum: ${p.room ?? "—"}  PIN: ${p.code}  Status: ${p.status}  TTLock: ${pushed}/${allKeys.length}  PIN brugt: ${pin}  Remote: ${remote}  BP: ${bp}\n`;
    }

    return out;
  }

  // ─── Email sending ─────────────────────────────────────────────────

  private async sendEmail(html: string, text: string, dateLabel: string) {
    const sgKeySetting = await this.storage.getSetting("sendgrid_api_key");
    const sgFromSetting = await this.storage.getSetting("sendgrid_from_email");
    const recipientSetting = await this.storage.getSetting("report_email");

    const apiKey = sgKeySetting?.value || process.env.SENDGRID_API_KEY;
    const fromEmail = sgFromSetting?.value || process.env.SENDGRID_FROM_EMAIL;
    const recipient = recipientSetting?.value || DEFAULT_REPORT_RECIPIENT;

    if (!apiKey || !fromEmail) {
      throw new Error("SendGrid credentials not configured");
    }
    if (!recipient) {
      console.log("[DailyReport] No recipient configured (report_email setting or USER_STATS_REPORT_EMAIL) — report skipped");
      return;
    }

    sgMail.setApiKey(apiKey);

    await sgMail.send({
      to: recipient,
      from: fromEmail,
      subject: `DreamBoks — Daglig rapport — ${dateLabel}`,
      text,
      html,
    });

    console.log(`[DailyReport] Report sent to ${recipient}`);
  }
}
