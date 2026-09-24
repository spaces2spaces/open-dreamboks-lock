/**
 * Daily upsell report (owner request 3/8): one mail per day at
 * `upsell_report_time` (default 12:00 hotel time) to `upsell_report_email`
 * with the results of the three upsell products — early check-in, late
 * check-out and hourly bookings — plus the morning's EC funnel (SMS sent →
 * link opened → quoted/rejected → bought), readable thanks to the
 * extras-funnel lookup logging.
 *
 * Sent by `_jobUpsellReport` in the state machine (same pattern as the
 * arrivals checklist reminder: last-sent date stamped BEFORE sending so a
 * failing mail provider can never become a send-per-tick storm).
 */
import { DateTime } from "luxon";
import type { ITenantStorage } from "./storage";
import type { HourlyBooking } from "@shared/schema";
import { createNotificationClient } from "./notification-client";

export interface UpsellDayStats {
  label: string;
  ecCount: number;
  ecDkk: number;
  lcCount: number;
  lcDkk: number;
  hourlyPaidCount: number;
  hourlyPaidDkk: number;
  hourlyAbandonedCount: number;
}

export interface UpsellFunnel {
  smsSent: number;
  smsFailed: number;
  lookups: number; // extras-page opens/attempts (marketing link auto-looks-up)
  quoted: number;
  rejectedByReason: Record<string, number>;
}

export interface UpsellReportData {
  hotelName: string;
  tz: string;
  generatedAtLabel: string;
  today: UpsellDayStats;
  yesterday: UpsellDayStats;
  /** Today's EC funnel (the 09:00 campaign has run by report time). */
  funnel: UpsellFunnel;
}

const num = (v: string | null | undefined): number => parseFloat(v ?? "") || 0;

export async function buildUpsellReportData(storage: ITenantStorage): Promise<UpsellReportData> {
  const tz = (await storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
  const hotelName = (await storage.getSetting("hotel_name"))?.value || "Hotel";
  const now = DateTime.now().setZone(tz);
  const todayStart = now.startOf("day");
  const yesterdayStart = todayStart.minus({ days: 1 });

  const emptyDay = (label: string): UpsellDayStats => ({
    label, ecCount: 0, ecDkk: 0, lcCount: 0, lcDkk: 0,
    hourlyPaidCount: 0, hourlyPaidDkk: 0, hourlyAbandonedCount: 0,
  });
  const today = emptyDay(now.setLocale("da").toFormat("cccc d/M"));
  const yesterday = emptyDay(yesterdayStart.setLocale("da").toFormat("cccc d/M"));
  const dayFor = (d: Date | string | null | undefined): UpsellDayStats | null => {
    if (!d) return null;
    const t = new Date(d).getTime();
    if (t >= todayStart.toMillis()) return today;
    if (t >= yesterdayStart.toMillis()) return yesterday;
    return null;
  };

  // EC/LC purchases: completed rows bucketed by completion day.
  try {
    const upsells = await storage.getCompletedUpsellsSince(yesterdayStart.toJSDate());
    for (const u of upsells) {
      const bucket = dayFor(u.completedAt);
      if (!bucket) continue;
      if (u.kind === "late_checkout") { bucket.lcCount++; bucket.lcDkk += num(u.amount); }
      else { bucket.ecCount++; bucket.ecDkk += num(u.amount); }
    }
  } catch { /* section degrades, report never breaks */ }

  // Hourly bookings: paid by payment day; abandoned = cancelled unpaid holds
  // by creation day (real cancellations of PAID bookings are not "abandoned").
  try {
    const bookings: HourlyBooking[] = await storage.getHourlyBookings(500);
    for (const b of bookings) {
      if (b.paidAt) {
        const bucket = dayFor(b.paidAt);
        if (bucket) { bucket.hourlyPaidCount++; bucket.hourlyPaidDkk += num(b.amount); }
      } else if (b.status === "cancelled") {
        const bucket = dayFor(b.createdAt);
        if (bucket) bucket.hourlyAbandonedCount++;
      }
    }
  } catch { /* section degrades */ }

  // Today's EC funnel from the targeted log sources.
  const funnel: UpsellFunnel = { smsSent: 0, smsFailed: 0, lookups: 0, quoted: 0, rejectedByReason: {} };
  try {
    const marketingLogs = await storage.getLogsBySourceSince("marketing", todayStart.toJSDate());
    for (const l of marketingLogs) {
      const run = /^Marketing early_checkin_offer run \((?:manual|scheduled)\): (\d+) sent, (\d+) failed/.exec(l.message);
      if (run) { funnel.smsSent += parseInt(run[1], 10); funnel.smsFailed += parseInt(run[2], 10); }
    }
    const funnelLogs = await storage.getLogsBySourceSince("extras-funnel", todayStart.toJSDate());
    for (const l of funnelLogs) {
      const m = /^Extras funnel: early_checkin lookup \((?:extras|kiosk|unknown)\) → (quoted|rejected: ([\w-]+))/.exec(l.message);
      if (!m) continue;
      funnel.lookups++;
      if (m[1] === "quoted") funnel.quoted++;
      else funnel.rejectedByReason[m[2]] = (funnel.rejectedByReason[m[2]] || 0) + 1;
    }
  } catch { /* funnel section degrades */ }

  return { hotelName, tz, generatedAtLabel: now.toFormat("HH:mm"), today, yesterday, funnel };
}

export function renderUpsellReport(data: UpsellReportData): { subject: string; body: string; html: string } {
  const totalDkk = (d: UpsellDayStats) => d.ecDkk + d.lcDkk + d.hourlyPaidDkk;
  const kr = (n: number) => `${n.toLocaleString("da-DK")} kr`;

  const subject = `Mersalg ${data.today.label}: ${kr(totalDkk(data.today))} indtil kl. ${data.generatedAtLabel} · i går ${kr(totalDkk(data.yesterday))}`;

  const dayLines = (d: UpsellDayStats) => [
    `  Timebookinger: ${d.hourlyPaidCount} betalte / ${kr(d.hourlyPaidDkk)}${d.hourlyAbandonedCount ? ` · ${d.hourlyAbandonedCount} forladte ubetalte` : ""}`,
    `  Early check-in: ${d.ecCount} køb / ${kr(d.ecDkk)}`,
    `  Late check-out: ${d.lcCount} køb / ${kr(d.lcDkk)}`,
    `  I alt: ${kr(totalDkk(d))}`,
  ];
  const rejections = Object.entries(data.funnel.rejectedByReason)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count}× ${reason}`)
    .join(", ");
  const funnelLine = data.funnel.smsSent || data.funnel.lookups
    ? `${data.funnel.smsSent} SMS sendt (${data.funnel.smsFailed} fejlede) → ${data.funnel.lookups} åbnede tilbuddet → ${data.funnel.quoted} fik pris${rejections ? ` (afvist: ${rejections})` : ""} → ${data.today.ecCount} købte`
    : `Ingen funnel-data endnu i dag.`;

  const body = [
    `MERSALGS-RAPPORT — ${data.hotelName}`,
    `${data.today.label} kl. ${data.generatedAtLabel} (${data.tz})`,
    "",
    `I DAG (indtil nu):`,
    ...dayLines(data.today),
    "",
    `I GÅR (${data.yesterday.label}):`,
    ...dayLines(data.yesterday),
    "",
    `EARLY CHECK-IN-TRAGTEN I DAG:`,
    `  ${funnelLine}`,
    "",
    `— Automatisk daglig rapport. Tidspunkt styres af settingen upsell_report_time; modtagere af upsell_report_email. DreamBoksLock.`,
  ].join("\n");

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const dayRow = (name: string, d: UpsellDayStats) =>
    `<tr><td style="padding:6px 10px;border-top:1px solid #e5e7eb;">${esc(name)}</td>` +
    `<td style="padding:6px 10px;border-top:1px solid #e5e7eb;text-align:right;">${d.hourlyPaidCount} / ${esc(kr(d.hourlyPaidDkk))}${d.hourlyAbandonedCount ? `<br><span style="color:#d97706;font-size:11px;">${d.hourlyAbandonedCount} forladte</span>` : ""}</td>` +
    `<td style="padding:6px 10px;border-top:1px solid #e5e7eb;text-align:right;">${d.ecCount} / ${esc(kr(d.ecDkk))}</td>` +
    `<td style="padding:6px 10px;border-top:1px solid #e5e7eb;text-align:right;">${d.lcCount} / ${esc(kr(d.lcDkk))}</td>` +
    `<td style="padding:6px 10px;border-top:1px solid #e5e7eb;text-align:right;font-weight:700;">${esc(kr(totalDkk(d)))}</td></tr>`;

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:640px;margin:0 auto;">` +
    `<h2 style="font-size:20px;margin:0 0 2px;">Mersalgs-rapport — ${esc(data.hotelName)}</h2>` +
    `<p style="color:#6b7280;font-size:13px;margin:0 0 14px;">${esc(data.today.label)} kl. ${esc(data.generatedAtLabel)} (${esc(data.tz)})</p>` +
    `<table style="border-collapse:collapse;width:100%;font-size:14px;"><thead><tr>` +
    `<th style="text-align:left;font-size:11px;text-transform:uppercase;color:#6b7280;padding:6px 10px;">Dag</th>` +
    `<th style="text-align:right;font-size:11px;text-transform:uppercase;color:#6b7280;padding:6px 10px;">⏱ Timebook.</th>` +
    `<th style="text-align:right;font-size:11px;text-transform:uppercase;color:#6b7280;padding:6px 10px;">🌅 Early</th>` +
    `<th style="text-align:right;font-size:11px;text-transform:uppercase;color:#6b7280;padding:6px 10px;">🌙 Late</th>` +
    `<th style="text-align:right;font-size:11px;text-transform:uppercase;color:#6b7280;padding:6px 10px;">I alt</th>` +
    `</tr></thead><tbody>` +
    dayRow(`I dag (${data.today.label})`, data.today) +
    dayRow(`I går (${data.yesterday.label})`, data.yesterday) +
    `</tbody></table>` +
    `<h3 style="font-size:15px;margin:18px 0 4px;">Early check-in-tragten i dag</h3>` +
    `<p style="font-size:14px;margin:0;">${esc(funnelLine)}</p>` +
    `<p style="color:#9ca3af;font-size:12px;margin-top:16px;">— Automatisk daglig rapport. DreamBoksLock.</p>` +
    `</div>`;

  return { subject, body, html };
}

/** Build + render + send to the `upsell_report_email` recipients. */
export async function sendDailyUpsellReport(storage: ITenantStorage): Promise<boolean> {
  const raw = (await storage.getSetting("upsell_report_email"))?.value;
  const recipients = (raw || "").split(/[,;\s]+/).map(s => s.trim()).filter(s => s.includes("@"));
  if (recipients.length === 0) return false;

  const { subject, body, html } = renderUpsellReport(await buildUpsellReportData(storage));
  const client = await createNotificationClient(storage);

  const delivered: string[] = [];
  const failed: string[] = [];
  for (const to of recipients) {
    const result = await client.sendPlainTextEmail({ to, subject, text: body, html });
    if (result.success) delivered.push(to);
    else failed.push(`${to} (${result.error})`);
  }
  await storage.createLog({
    level: failed.length === 0 ? "info" : "warn",
    message: `Upsell report sent to ${delivered.join(", ") || "none"}${failed.length ? ` — FAILED: ${failed.join("; ")}` : ""}`,
    source: "upsell-report",
  });
  return delivered.length > 0;
}
