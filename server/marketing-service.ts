/**
 * Marketing/upsell SMS campaigns (owner request 27/7): configurable offer-SMS
 * to guests — first campaigns: early check-in (today's arrivals) and late
 * checkout (today's departures). Both link to the guest extras page
 * ({app_base_url}/{hotel_slug}/extras) where the guest pays from their phone.
 *
 * Design:
 *  - Campaign registry below — adding a product = one more entry.
 *  - Per-stay dedupe AND concurrency guard = claim-then-send against the
 *    partial unique index on marketing_sends (reservation, campaign) WHERE
 *    status='sent'. A failed Twilio send downgrades the row to 'failed',
 *    freeing the slot for retry.
 *  - Scheduler (runDueMarketingCampaigns, called from the minute tick): fires
 *    inside [send_time, send_time + 90 min) once per day. The 90-min window
 *    prevents an evening blast when the owner enables a campaign after its
 *    send time. Date-stamp BEFORE sending (23/7 lesson: a failing provider
 *    must not become a send-per-tick storm); all-failed re-opens the stamp.
 *  - Manual "Send now" (and dryRun/testTo) always works regardless of enabled.
 */
import { DateTime } from "luxon";
import type { ITenantStorage } from "./storage";
import type { Reservation } from "@shared/schema";
import { createNotificationClient } from "./notification-client";

export type MarketingCampaignId = "early_checkin_offer" | "late_checkout_offer";

export interface MarketingCampaign {
  id: MarketingCampaignId;
  label: string;
  defaultSendTime: string;
  /** GSM-7 only (no emojis — they force UCS-2/70-char segments). Placeholders: {name} {hotel} {link} */
  defaultSmsText: string;
  /** The extras page opens ONLY this campaign's offer (owner 5/8): "ec" | "lc". */
  offer: "ec" | "lc";
  audience(storage: ITenantStorage, now: DateTime): Promise<Reservation[]>;
  /**
   * Test-send fallback (owner 5/8: a midday test after the real run rendered a
   * link WITHOUT ?code because everyone was already claimed): candidates with
   * NO already-sent/already-bought/time-window filtering, so the tester always
   * sees the personalized one-tap flow a guest gets.
   */
  sampleAudience(storage: ITenantStorage, now: DateTime): Promise<Reservation[]>;
}

const ACTIVE_STAY_STATUSES = new Set(["checked-in", "started"]);

function hhmm(setting: string | undefined, fallback: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec((setting || fallback).trim());
  return {
    hour: match ? Math.min(23, parseInt(match[1], 10)) : parseInt(fallback, 10),
    minute: match ? Math.min(59, parseInt(match[2], 10)) : 0,
  };
}

async function upsellFilter(
  storage: ITenantStorage,
  candidates: Reservation[],
  kind: "early_checkin" | "late_checkout",
  campaign: MarketingCampaignId,
): Promise<Reservation[]> {
  const upsells = await storage.getUpsellsByReservationIds(candidates.map(r => r.id));
  const withUpsell = new Set(
    upsells
      .filter(u => u.kind === kind && ["completed", "awaiting_inspection", "pending_payment"].includes(u.status))
      .map(u => u.reservationId),
  );
  const alreadySent = await storage.getMarketingSentReservationIds(campaign);
  return candidates.filter(r => !withUpsell.has(r.id) && !alreadySent.has(r.id));
}

export const MARKETING_CAMPAIGNS: MarketingCampaign[] = [
  {
    id: "early_checkin_offer",
    label: "Early check-in offer",
    defaultSendTime: "09:00",
    defaultSmsText:
      "Hi {name}! Want to check in early today at {hotel}? See your price and pay in a minute from your phone: {link}",
    offer: "ec",
    async sampleAudience(storage, now) {
      const dayStart = now.startOf("day");
      const arrivals = await storage.getMappedReservationsByArrivalRange(
        dayStart.toJSDate(),
        dayStart.plus({ days: 1 }).toJSDate(),
      );
      return arrivals.filter(r => !!r.generatedPin);
    },
    async audience(storage, now) {
      // Today's arrivals that could still buy early check-in: not yet checked
      // in, reachable by SMS, fully paid (the EC quote rejects owing anyway),
      // door-code message already out (the offer references their code), no
      // EC bought/in progress, and only before the normal check-in time.
      const checkIn = hhmm((await storage.getSetting("check_in_time"))?.value, "15:00");
      if (now >= now.set({ ...checkIn, second: 0, millisecond: 0 })) return [];
      const dayStart = now.startOf("day");
      const arrivals = await storage.getMappedReservationsByArrivalRange(
        dayStart.toJSDate(),
        dayStart.plus({ days: 1 }).toJSDate(),
      );
      const candidates = arrivals.filter(r =>
        (r.status || "").toLowerCase() === "confirmed" &&
        !!r.mobile &&
        (parseFloat(r.owing ?? "0") || 0) === 0 &&
        !!r.generatedPin &&
        !!(r.doorCodeSentAt || r.notificationSent) &&
        !r.earlyCheckinFrom,
      );
      return upsellFilter(storage, candidates, "early_checkin", "early_checkin_offer");
    },
  },
  {
    id: "late_checkout_offer",
    label: "Late check-out offer",
    defaultSendTime: "19:00",
    // One-segment SMS (owner 4/8): with the short /e/<code> link this renders
    // ≤154 chars — no signature needed, the branded sender ID carries it. No
    // prices in the text either (owner 4/8): the guest sees them on the page.
    defaultSmsText:
      "Sleep longer tomorrow? Extend checkout until 12:00, 13:00 or 14:00. Your door code stays active. Choose and pay: {link}",
    offer: "lc",
    async sampleAudience(storage, now) {
      const dayStart = now.startOf("day").plus({ days: 1 });
      const departures = await storage.getMappedReservationsByDepartureRange(
        dayStart.toJSDate(),
        dayStart.plus({ days: 1 }).toJSDate(),
      );
      return departures.filter(r => !!r.generatedPin);
    },
    async audience(storage, now) {
      // Evening offer (owner 4/8, was a 07:30 same-day send): sent at 19:00
      // the EVENING BEFORE departure — targets TOMORROW's departures. Both
      // in-house guests and tonight's not-yet-arrived (Confirmed) guests
      // qualify; the door-code gate below covers the {link} personalization
      // either way (codes go out ~23h before arrival).
      const dayStart = now.startOf("day").plus({ days: 1 });
      const departures = await storage.getMappedReservationsByDepartureRange(
        dayStart.toJSDate(),
        dayStart.plus({ days: 1 }).toJSDate(),
      );
      const candidates = departures.filter(r => {
        const status = (r.status || "").toLowerCase();
        return (ACTIVE_STAY_STATUSES.has(status) || status === "confirmed") &&
          !!r.mobile &&
          (parseFloat(r.owing ?? "0") || 0) === 0 &&
          // A door code must exist so {link} is always personalized
          // (…/extras?code=XXXX) and opens pre-filled.
          !!r.generatedPin &&
          !r.lateCheckoutUntil;
      });
      return upsellFilter(storage, candidates, "late_checkout", "late_checkout_offer");
    },
  },
];

export function getCampaign(id: string): MarketingCampaign | undefined {
  return MARKETING_CAMPAIGNS.find(c => c.id === id);
}

export async function renderSmsText(storage: ITenantStorage, campaign: MarketingCampaign, reservation?: Reservation): Promise<string> {
  const override = (await storage.getSetting(`marketing_${campaign.id}_sms_text`))?.value?.trim();
  const template = override || campaign.defaultSmsText;
  const hotelName = (await storage.getSetting("hotel_name"))?.value || "our hotel";
  const slug = (await storage.getSetting("hotel_slug"))?.value || "";
  const baseRaw = (await storage.getSetting("app_base_url"))?.value || "https://lock.dreamboks.net";
  // Personalized link: the guest already got their door code by SMS (audience
  // requires it), so the code pre-fills the /extras lookup — one tap, no typing.
  const pin = reservation?.generatedPin?.trim();
  const base = baseRaw.replace(/\/+$/, "");
  // Short form (owner 4/8: one-segment SMS): on a hotel's OWN domain,
  // /e/<code> redirects to the extras page — 29 chars shorter. The shared
  // default domain cannot resolve a tenant from the hostname (the /e route
  // matches host against app_base_url), so it keeps the long form.
  // ?o=/&offer= (owner 5/8): the page opens ONLY this campaign's offer.
  let ownDomain = false;
  try { ownDomain = new URL(base).hostname.toLowerCase() !== "lock.dreamboks.net"; } catch { /* malformed base — long form */ }
  const link = pin && ownDomain
    ? `${base}/e/${encodeURIComponent(pin)}?o=${campaign.offer}`
    : `${base}/${slug}/extras?${pin ? `code=${encodeURIComponent(pin)}&` : ""}offer=${campaign.offer}`;
  return template
    .replaceAll("{name}", reservation?.firstName?.trim() || "there")
    .replaceAll("{hotel}", hotelName)
    .replaceAll("{link}", link);
}

export interface RunCampaignResult {
  ok: boolean;
  dryRun?: boolean;
  test?: boolean;
  to?: string;
  body?: string;
  recipients?: Array<{ reservationId: string; name: string; mobile: string; body: string }>;
  sent?: Array<{ reservationId: string; name: string; mobile: string }>;
  failed?: Array<{ reservationId: string; name: string; mobile: string; error: string }>;
  skipped?: Array<{ reservationId: string; reason: string }>;
  error?: string;
}

export async function runCampaign(
  storage: ITenantStorage,
  campaignId: string,
  opts: { dryRun?: boolean; testTo?: string; trigger?: "manual" | "scheduled" } = {},
): Promise<RunCampaignResult> {
  const campaign = getCampaign(campaignId);
  if (!campaign) return { ok: false, error: `Unknown campaign: ${campaignId}` };

  const tz = (await storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
  const now = DateTime.now().setZone(tz);

  // Test send: one sample SMS to the given number, no claims. Rendered with a
  // real audience member when there is one, so the tester sees the exact
  // personalized link (?code=...) a guest would get.
  if (opts.testTo) {
    // Personalize with a real audience member; when the run already claimed
    // everyone (or the window closed), fall back to any plausible candidate so
    // the tester still sees the one-tap ?code flow a guest gets.
    const sample = (await campaign.audience(storage, now))[0]
      ?? (await campaign.sampleAudience(storage, now))[0];
    const body = await renderSmsText(storage, campaign, sample);
    const client = await createNotificationClient(storage);
    const result = await client.sendPlainSMS({ to: opts.testTo, body });
    await storage.createLog({
      level: result.success ? "info" : "error",
      message: `Marketing test SMS (${campaign.id}) ${result.success ? "sent" : `FAILED (${result.error})`} to ${opts.testTo}`,
      source: "marketing",
    });
    return { ok: result.success, test: true, to: opts.testTo, body, error: result.error };
  }

  const rawAudience = await campaign.audience(storage, now);
  // One SMS per PHONE: multi-capsule bookings (same guest, several
  // reservations) must not produce duplicate texts. First reservation wins;
  // the sibling reservation simply goes unclaimed this run.
  const seenMobiles = new Set<string>();
  const audience = rawAudience.filter(r => {
    const key = (r.mobile || "").replace(/[\s-]+/g, "");
    if (seenMobiles.has(key)) return false;
    seenMobiles.add(key);
    return true;
  });
  const maxRecipients = parseInt((await storage.getSetting("marketing_max_recipients"))?.value || "50", 10) || 50;
  if (audience.length > maxRecipients) {
    await storage.createLog({
      level: "error",
      message: `Marketing ${campaign.id}: audience ${audience.length} exceeds marketing_max_recipients (${maxRecipients}) — ABORTED. Raise the cap deliberately if this is expected.`,
      source: "marketing",
    });
    return { ok: false, error: `Audience (${audience.length}) exceeds the safety cap (${maxRecipients}). Nothing sent.` };
  }

  if (opts.dryRun) {
    const recipients = [] as NonNullable<RunCampaignResult["recipients"]>;
    for (const r of audience) {
      recipients.push({
        reservationId: r.id,
        name: `${r.firstName} ${r.lastName}`.trim(),
        mobile: r.mobile!,
        body: await renderSmsText(storage, campaign, r),
      });
    }
    return { ok: true, dryRun: true, recipients };
  }

  // Real send. boarding_test_phone redirects every guest SMS system-wide
  // (same override as the door-code sender) — sentTo records the actual number.
  const testPhoneOverride = (await storage.getSetting("boarding_test_phone"))?.value || null;
  const client = await createNotificationClient(storage);
  const sent: NonNullable<RunCampaignResult["sent"]> = [];
  const failed: NonNullable<RunCampaignResult["failed"]> = [];
  const skipped: NonNullable<RunCampaignResult["skipped"]> = [];

  for (const r of audience) {
    const to = testPhoneOverride || r.mobile!;
    const body = await renderSmsText(storage, campaign, r);
    const claim = await storage.createMarketingSendClaim({
      reservationId: r.id,
      guestName: `${r.firstName} ${r.lastName}`.trim() || null,
      campaign: campaign.id,
      status: "sent",
      sentTo: to,
      body,
      trigger: opts.trigger || "manual",
    });
    if (!claim) {
      skipped.push({ reservationId: r.id, reason: "already sent (or concurrent send)" });
      continue;
    }
    const result = await client.sendPlainSMS({ to, body });

    // Dual channel (owner request 4/8, was invalid-number fallback only):
    // every guest with a usable address ALSO gets the same text by email —
    // and a guest whose number Twilio rejects still gets the offer that way.
    // Skipped under the test-phone override — test runs must never email
    // real guests. One claim covers both channels, so the per-stay dedupe
    // holds regardless of which channel(s) landed.
    const guestEmail = (r.personalEmail || r.email || "").trim();
    let emailedTo: string | null = null;
    if (!testPhoneOverride && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail)) {
      const hotelName = (await storage.getSetting("hotel_name"))?.value || "Copenhagen Downtown Hostel";
      const emailResult = await client.sendPlainTextEmail({
        to: guestEmail,
        subject: `${hotelName} — an offer for your stay`,
        text: body,
      });
      if (emailResult.success) emailedTo = guestEmail;
    }

    if (result.success || emailedTo) {
      const channels = [result.success ? to : null, emailedTo].filter(Boolean).join(" + ");
      await storage.updateMarketingSend(claim.id, {
        sentTo: channels,
        ...(result.success ? {} : { error: `sms failed (${result.error}) — delivered by email` }),
      });
      sent.push({ reservationId: r.id, name: `${r.firstName} ${r.lastName}`.trim(), mobile: channels });
      await storage.createLog({
        level: "info",
        message: `Marketing ${campaign.id}: ${result.success ? `SMS sent to ${to}` : `SMS failed (${result.error})`}${emailedTo ? ` + EMAIL to ${emailedTo}` : ""} for ${r.firstName} ${r.lastName}`,
        source: "marketing",
        reservationId: r.id,
      });
      continue;
    }

    await storage.updateMarketingSend(claim.id, { status: "failed", error: result.error || "unknown" });
    failed.push({ reservationId: r.id, name: `${r.firstName} ${r.lastName}`.trim(), mobile: to, error: result.error || "unknown" });
    await storage.createLog({
      level: "warn",
      message: `Marketing ${campaign.id}: SMS FAILED (${result.error}) to ${to} for ${r.firstName} ${r.lastName}`,
      source: "marketing",
      reservationId: r.id,
    });
  }

  await storage.createLog({
    level: "info",
    message: `Marketing ${campaign.id} run (${opts.trigger || "manual"}): ${sent.length} sent, ${failed.length} failed, ${skipped.length} skipped`,
    source: "marketing",
  });
  return { ok: true, sent, failed, skipped };
}

const SCHEDULE_WINDOW_MS = 90 * 60 * 1000;
const RETRY_BACKOFF_MS = 30 * 60 * 1000;
const retryAfterByCampaign = new Map<string, number>();

/** Minute-tick entry: fire each enabled campaign once/day inside its window. */
export async function runDueMarketingCampaigns(storage: ITenantStorage, nowOverride?: DateTime): Promise<void> {
  const tz = (await storage.getSetting("property_timezone"))?.value || "Europe/Copenhagen";
  const now = nowOverride ?? DateTime.now().setZone(tz);

  for (const campaign of MARKETING_CAMPAIGNS) {
    try {
      if ((await storage.getSetting(`marketing_${campaign.id}_enabled`))?.value !== "true") continue;
      if (Date.now() < (retryAfterByCampaign.get(campaign.id) ?? 0)) continue;

      const at = hhmm((await storage.getSetting(`marketing_${campaign.id}_send_time`))?.value, campaign.defaultSendTime);
      const sendAt = now.set({ hour: at.hour, minute: at.minute, second: 0, millisecond: 0 });
      if (now < sendAt || now.toMillis() - sendAt.toMillis() >= SCHEDULE_WINDOW_MS) continue;

      const today = now.toFormat("yyyy-MM-dd");
      const stampKey = `marketing_${campaign.id}_last_sent_date`;
      const lastSent = (await storage.getSetting(stampKey))?.value;
      if (lastSent === today) continue;
      // Stamp BEFORE sending (23/7 lesson) — all-failed re-opens + backs off.
      await storage.setSetting(stampKey, today);

      const result = await runCampaign(storage, campaign.id, { trigger: "scheduled" });
      const attempted = (result.sent?.length ?? 0) + (result.failed?.length ?? 0);
      if (!result.ok || (attempted > 0 && (result.sent?.length ?? 0) === 0)) {
        await storage.setSetting(stampKey, lastSent || "");
        retryAfterByCampaign.set(campaign.id, Date.now() + RETRY_BACKOFF_MS);
      }
    } catch (error) {
      await storage.createLog({
        level: "error",
        message: `Marketing scheduler failed for ${campaign.id}: ${error instanceof Error ? error.message : String(error)}`,
        source: "marketing",
      });
    }
  }
}
