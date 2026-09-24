/**
 * Ops alerts — operational e-mail alerts for conditions that endanger guest
 * access (missing door codes that survive auto-repair, aborted destructive
 * jobs, unverified code sends, offline common-door gateways).
 *
 * Channel decision (owner, 22/7): e-mail ONLY, same recipient list as the
 * arrival report (`lock_arrival_report_email`), same overall cadence. No SMS.
 * The compensation for a passive channel is that detection now triggers
 * automatic repair elsewhere — these alerts are the human-oversight layer on
 * top, not the primary defense.
 *
 * Dedupe: at most one e-mail per (key, content) per DEDUPE_WINDOW_MS, tracked
 * in a per-tenant setting so restarts don't re-alert. A CRITICAL alert whose
 * content CHANGED (e.g. the number of missing codes grew) bypasses the window
 * — mirroring the arrival report's "send immediately when the alarm signature
 * changes" behavior.
 */
import { createHash } from "crypto";
import { createNotificationClient } from "./notification-client";

export type OpsAlertSeverity = "warning" | "critical";

// Minimal structural storage contract so every storage flavor (ITenantStorage,
// IStorage, test mocks) can be passed without casts.
export interface OpsAlertStorage {
  getSetting(key: string): Promise<{ value: string } | null | undefined>;
  setSetting(key: string, value: string): Promise<unknown>;
  createLog(log: { level: string; message: string; source: string; metadata?: unknown }): Promise<unknown>;
}

const DEDUPE_WINDOW_MS = 60 * 60 * 1000;
const STATE_SETTING_PREFIX = "ops_alert_state:";

interface AlertState {
  hash: string;
  sentAt: string;
}

export async function sendOpsAlert(
  storage: OpsAlertStorage,
  key: string,
  severity: OpsAlertSeverity,
  message: string,
  detail?: string
): Promise<boolean> {
  try {
    const raw = (await storage.getSetting("lock_arrival_report_email"))?.value;
    const recipients = (raw || "").split(/[,;\s]+/).map(s => s.trim()).filter(s => s.includes("@"));
    if (recipients.length === 0) {
      // No configured recipients — log loudly so the condition is still visible.
      await storage.createLog({
        level: "error",
        message: `OPS ALERT (no recipients configured — set lock_arrival_report_email): [${severity}] ${message}`,
        source: "ops-alert",
        metadata: { key, severity },
      });
      return false;
    }

    const hash = createHash("sha256").update(`${severity}|${message}|${detail || ""}`).digest("hex").slice(0, 16);
    const stateKey = `${STATE_SETTING_PREFIX}${key}`;
    const prevRaw = (await storage.getSetting(stateKey))?.value;
    let prev: AlertState | null = null;
    if (prevRaw) {
      try { prev = JSON.parse(prevRaw) as AlertState; } catch { prev = null; }
    }

    const now = Date.now();
    const withinWindow = prev ? now - new Date(prev.sentAt).getTime() < DEDUPE_WINDOW_MS : false;
    const contentChanged = !prev || prev.hash !== hash;

    // Suppress when: identical content inside the window, OR unchanged-content
    // warning inside the window. Critical + changed content always goes out.
    if (withinWindow && (!contentChanged || severity === "warning")) {
      return false;
    }

    const prefix = severity === "critical" ? "🚨 URGENT" : "⚠️";
    const subject = `${prefix} DreamBoksLock: ${message}`;
    const bodyLines = [
      message,
      "",
      ...(detail ? [detail, ""] : []),
      `Severity: ${severity}`,
      `Alert key: ${key}`,
      `Time: ${new Date(now).toISOString()}`,
    ];
    const body = bodyLines.join("\n");

    const client = await createNotificationClient(storage);
    let delivered = false;
    for (const to of recipients) {
      const result = await client.sendPlainTextEmail({ to, subject, text: body });
      if (result.success) delivered = true;
    }

    // Arm the dedupe window ONLY on successful delivery — otherwise a failed
    // send (SendGrid hiccup) would suppress the retry for a full hour and a
    // critical alert could be lost entirely.
    if (delivered) {
      await storage.setSetting(stateKey, JSON.stringify({ hash, sentAt: new Date(now).toISOString() } satisfies AlertState));
    }
    await storage.createLog({
      level: severity === "critical" ? "error" : "warn",
      message: `Ops alert ${delivered ? "sent" : "FAILED to send"}: [${severity}] ${message}`,
      source: "ops-alert",
      metadata: { key, severity, recipients: recipients.join(", ") },
    });
    return delivered;
  } catch (error) {
    // An alert failure must never break the calling job.
    await storage.createLog({
      level: "error",
      message: `Ops alert error for key ${key}: ${error instanceof Error ? error.message : String(error)}`,
      source: "ops-alert",
    }).catch(() => {});
    return false;
  }
}
