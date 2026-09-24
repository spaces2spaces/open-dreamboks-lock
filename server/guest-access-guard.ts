/**
 * Guest access guard — brute-force defence for the public guest endpoints.
 *
 * The public API identifies a guest by a reservation identifier plus last
 * name (digital key, remote unlock, payment requests) or by a 4-digit door
 * code (PIN check-in). Form-grade identifiers (see shared/guest-identifier.ts)
 * are short or sequential, so on top of the per-IP rate limiters this guard
 * adds what per-IP limits cannot give behind a hotel-WiFi NAT:
 *
 *  1. Per-reservation lockout: LOCK_AFTER failed lookups of the SAME
 *     form-grade identifier within LOCK_WINDOW_MS lock that identifier for
 *     LOCK_DURATION_MS — even a subsequently correct name is refused. Keyed
 *     by (tenant, identifier), so one guest's typo never affects another,
 *     and a shared IP is never punished as a whole. Link-grade identifiers
 *     (UUIDs) are never locked: they cannot be enumerated.
 *  2. Tenant-wide anomaly alert: failures of any kind (lookups, PIN probes,
 *     kiosk lookups, wrong door code on unlock) are counted per tenant over
 *     ALERT_WINDOW_MS; crossing ALERT_WARN_AT / ALERT_CRITICAL_AT sends an
 *     ops alert (e-mail, deduped by ops-alert.ts). The alert text is bucketed
 *     ("30+", "100+") so the dedupe window is not defeated by a rising count.
 *
 * State is in-memory per process: a restart clears it, which is acceptable —
 * the IP limiters still apply and the alert re-arms on the next burst.
 */
import { isLinkGradeIdentifier } from "@shared/guest-identifier";
import { sendOpsAlert, type OpsAlertStorage } from "./ops-alert";

export const LOCK_AFTER = 5;
export const LOCK_WINDOW_MS = 60 * 60 * 1000;
export const LOCK_DURATION_MS = 60 * 60 * 1000;
export const ALERT_WINDOW_MS = 10 * 60 * 1000;
export const ALERT_WARN_AT = 30;
export const ALERT_CRITICAL_AT = 100;
export const ALERT_KEY = "public-lookup-bruteforce";

interface Failure { at: number; ip: string }

export class GuestAccessGuard {
  private failuresByTarget = new Map<string, number[]>();
  private lockedUntil = new Map<string, number>();
  private failuresByTenant = new Map<string, Failure[]>();

  constructor(private readonly now: () => number = Date.now) {}

  private targetKey(tenantId: string, identifier: string): string {
    return `${tenantId}|${identifier.trim().toLowerCase()}`;
  }

  /** Milliseconds until a form-grade identifier is usable again; 0 when not locked. */
  lockedFor(tenantId: string, identifier: string): number {
    if (isLinkGradeIdentifier(identifier)) return 0;
    const until = this.lockedUntil.get(this.targetKey(tenantId, identifier));
    if (!until) return 0;
    const remaining = until - this.now();
    if (remaining <= 0) {
      this.lockedUntil.delete(this.targetKey(tenantId, identifier));
      return 0;
    }
    return remaining;
  }

  /**
   * A lookup with this identifier failed (wrong number, wrong name, or wrong
   * door code). Counts toward the tenant alert; locks the identifier after
   * LOCK_AFTER failures unless it is link-grade.
   */
  async recordFailure(tenantId: string, identifier: string, ip: string | undefined, storage?: OpsAlertStorage): Promise<{ locked: boolean }> {
    const now = this.now();
    let locked = false;
    if (!isLinkGradeIdentifier(identifier)) {
      const key = this.targetKey(tenantId, identifier);
      const hits = (this.failuresByTarget.get(key) ?? []).filter(t => now - t < LOCK_WINDOW_MS);
      hits.push(now);
      this.failuresByTarget.set(key, hits);
      if (hits.length >= LOCK_AFTER) {
        this.lockedUntil.set(key, now + LOCK_DURATION_MS);
        this.failuresByTarget.delete(key);
        locked = true;
      }
    }
    await this.recordProbe(tenantId, ip, storage);
    return { locked };
  }

  /**
   * A guess that has no single target to lock (door-code probe, kiosk name
   * lookup): counts toward the tenant alert only.
   */
  async recordProbe(tenantId: string, ip: string | undefined, storage?: OpsAlertStorage): Promise<number> {
    const now = this.now();
    const list = (this.failuresByTenant.get(tenantId) ?? []).filter(f => now - f.at < ALERT_WINDOW_MS);
    list.push({ at: now, ip: ip || "unknown" });
    this.failuresByTenant.set(tenantId, list);
    if (storage) await this.maybeAlert(tenantId, list, storage);
    return list.length;
  }

  /** A successful lookup clears the identifier's failure streak (a guest who finally got it right). */
  recordSuccess(tenantId: string, identifier: string): void {
    this.failuresByTarget.delete(this.targetKey(tenantId, identifier));
  }

  private async maybeAlert(tenantId: string, failures: Failure[], storage: OpsAlertStorage): Promise<void> {
    const n = failures.length;
    if (n < ALERT_WARN_AT) return;
    const critical = n >= ALERT_CRITICAL_AT;
    // Bucketed so the message is stable while the count climbs (ops-alert
    // dedupes on content; a changing number would re-send on every request).
    const bucket = critical ? `${ALERT_CRITICAL_AT}+` : `${ALERT_WARN_AT}+`;
    const ips = new Map<string, number>();
    for (const f of failures) ips.set(f.ip, (ips.get(f.ip) ?? 0) + 1);
    const topIps = [...ips.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([ip, c]) => `${ip} (${c})`).join(", ");
    await sendOpsAlert(
      storage,
      ALERT_KEY,
      critical ? "critical" : "warning",
      `Possible brute force on guest lookups: ${bucket} failed attempts in ${ALERT_WINDOW_MS / 60000} minutes`,
      `Distinct IPs: ${ips.size}. Most active: ${topIps}. Per-reservation lockouts and rate limits are active; check the logs for the targeted identifiers.`,
    );
  }

  /** Test hook. */
  reset(): void {
    this.failuresByTarget.clear();
    this.lockedUntil.clear();
    this.failuresByTenant.clear();
  }
}

export const guestAccessGuard = new GuestAccessGuard();
