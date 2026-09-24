import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, Clock, KeyRound, AlertCircle, CheckCircle2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { type GuestTheme, guestThemeStyle, useGuestFont, useFavicon } from "@/lib/guest-theme";

interface HotelInfo {
  name: string;
  slug: string;
  theme?: GuestTheme | null;
}

interface HourlyInfo {
  hotelName: string;
  timezone: string;
  maxHours: number;
  pricePerHour: number | null;
  currency: string | null;
  /** DKK→EUR display rate ("399 DKK (≈ €54)"), from settings. */
  eurRate: number;
  /** Fixed-price packages (e.g. 3 h = 399) — when present, the ONLY durations on sale. */
  products: Array<{ hours: number; price: number }>;
  paymentConfigured: boolean;
}

interface BookingStatus {
  status: string;
  code: string | null;
  capsule: string | null;
  startAt: string;
  endAt: string;
  codeDelivered: boolean;
}

// Includes the overnight lengths (5h = e.g. 23–04; slots stitch across
// midnight server-side, so late starts offer their full run).
const DURATIONS = [1, 2, 3, 4, 5, 6, 8, 10, 12];

/** Interpret a datetime-local wall time in the PROPERTY's timezone (guests may book from anywhere). */
function wallTimeToInstant(wall: string, timeZone: string): Date {
  const [datePart, timePart] = wall.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, hh, mm);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = dtf.formatToParts(new Date(utcGuess));
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return new Date(utcGuess - (asUtc - utcGuess));
}

function fmtInTz(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

export default function HourlyBookingPage() {
  const params = useParams<{ hotel: string }>();
  const slug = params.hotel || "";

  const [hotelInfo, setHotelInfo] = useState<HotelInfo | null>(null);
  const [info, setInfo] = useState<HourlyInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  // Form state
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [startLocal, setStartLocal] = useState("");
  const [durationHours, setDurationHours] = useState(2);
  // Real bookable slots (owner request 23/7): date + hour grid from
  // /api/public/hourly/slots. Falls back to the manual datetime field if the
  // slot fetch fails, so booking never becomes impossible.
  const [dateISO, setDateISO] = useState<string | null>(null);
  const [slots, setSlots] = useState<Array<{ startAt: string; hour: number; maxHours: number; now?: boolean }> | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsFailed, setSlotsFailed] = useState(false);
  const [selectedStart, setSelectedStart] = useState<string | null>(null);
  const [availability, setAvailability] = useState<{ count: number; price: { total: number; hours: number; currency: string } | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Confirmation state (after Stripe redirect back)
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const returnedBookingId = urlParams.get("booking");
  // Kiosk mode (the info screen's Quick book tile links with ?kiosk=1):
  // payment is a QR the guest scans and pays on THEIR phone — the wall
  // tablet never navigates away (owner decision 24/7, mirrors the early
  // check-in / late check-out kiosk flows).
  const isKiosk = urlParams.get("kiosk") === "1";
  const [kioskPay, setKioskPay] = useState<{ bookingId: string; checkoutUrl: string; dkk: number | null } | null>(null);
  const wasCancelled = urlParams.get("cancelled") === "1";
  const [bookingStatus, setBookingStatus] = useState<BookingStatus | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);

  useEffect(() => {
    document.title = "Book a Capsule by the Hour";
    if (!slug) return;
    fetch(`/api/public/hotel-info/${slug}`)
      .then(res => res.json())
      .then(data => {
        if (data?.name) {
          setHotelInfo(data);
          document.title = `Hourly Booking - ${data.name}`;
        }
      })
      .catch(() => {});
    fetch("/api/public/hourly/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hotelSlug: slug }),
    })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Not available");
        setInfo(data);
        // Package mode: preselect the first package so the slot grid filters
        // to a valid duration immediately (one-screen flow). ?hours=3|6 lets
        // the marketing site's buttons deep-link a specific package (25/7).
        if (Array.isArray(data.products) && data.products.length > 0) {
          const wanted = parseInt(urlParams.get("hours") || "", 10);
          const match = data.products.find((p: { hours: number }) => p.hours === wanted);
          setDurationHours((match ?? data.products[0]).hours);
        }
      })
      .catch(e => setInfoError(e.message));
  }, [slug]);

  // Poll booking status after payment redirect. STOPS on a terminal status
  // (confirmed/cancelled/expired). Adaptive cadence: every 3s for the first
  // 2 minutes (guest just paid), then every 15s up to ~40 min (MEWS payments
  // happen in another tab and can take a while) — stays well inside the rate
  // limit and never hammers the API from an abandoned tab.
  useEffect(() => {
    const pollId = returnedBookingId || kioskPay?.bookingId;
    if (!pollId || !slug) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/public/hourly/booking/${pollId}?hotel=${encodeURIComponent(slug)}`);
        const data = await res.json();
        if (cancelled) return;
        if (res.ok) {
          setBookingStatus(data);
          // "confirmed" is only terminal once the CODE is issued — payment
          // confirmation and lock issuance are seconds apart, and stopping in
          // between would leave the screen without the capsule/pin (the whole
          // point of the kiosk flow).
          const terminal = ["cancelled", "expired"].includes(data.status) ||
            (data.status === "confirmed" && !!data.code);
          if (terminal) return;
        }
      } catch { /* retry on next tick */ }
      const elapsed = Date.now() - startedAt;
      if (elapsed > 40 * 60_000) { setPollTimedOut(true); return; }
      timer = setTimeout(poll, elapsed < 2 * 60_000 ? 3000 : 15_000);
    };
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [returnedBookingId, kioskPay, slug]);

  // Kiosk auto-return (owner decision 24/7): after the confirmation (capsule
  // + code shown, and also delivered by SMS/email) the wall tablet goes back
  // to the info screen HOME after ~15s — a shared screen must neither linger
  // on a guest's door code nor strand the next guest in the booking flow.
  useEffect(() => {
    if (!isKiosk || !bookingStatus) return;
    if (!["confirmed", "cancelled", "expired"].includes(bookingStatus.status)) return;
    const t = setTimeout(() => { window.location.href = `/${slug}/info`; }, 15_000);
    return () => clearTimeout(t);
  }, [isKiosk, bookingStatus, slug]);

  // "399 DKK (≈ €54)" — same presentation as the early/late check-in flows.
  const eur = (dkk: number) => (info?.eurRate ? ` (≈ €${Math.round(dkk / info.eurRate)})` : "");

  const theme = hotelInfo?.theme || null;
  const baseStyle = guestThemeStyle(theme);
  // Same pattern as the other guest pages: brand font on the whole page.
  const rootStyle = theme?.font ? { ...baseStyle, fontFamily: "var(--guest-font)" } : baseStyle;
  useGuestFont(theme?.font);
  useFavicon(theme?.logoUrl, theme?.brand || null);

  // Hotel-tz "today" + the next 7 days for the date picker.
  const dateOptions = useMemo(() => {
    if (!info) return [];
    const fmtISO = new Intl.DateTimeFormat("en-CA", { timeZone: info.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    const fmtLabel = new Intl.DateTimeFormat("en-GB", { timeZone: info.timezone, weekday: "short", day: "numeric", month: "short" });
    return Array.from({ length: 8 }, (_, i) => {
      const d = new Date(Date.now() + i * 86_400_000);
      return { iso: fmtISO.format(d), label: i === 0 ? "Today" : fmtLabel.format(d) };
    });
  }, [info]);

  useEffect(() => {
    if (!dateISO && dateOptions.length > 0) setDateISO(dateOptions[0].iso);
  }, [dateOptions, dateISO]);

  // Load the bookable start hours whenever the date changes.
  useEffect(() => {
    if (!slug || !info || !dateISO) return;
    let cancelled = false;
    setSlotsLoading(true);
    setSlots(null);
    setSelectedStart(null);
    fetch("/api/public/hourly/slots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hotelSlug: slug, date: dateISO }),
    })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load available times");
        if (!cancelled) { setSlots(data.startHours ?? []); setSlotsFailed(false); }
      })
      .catch(() => { if (!cancelled) { setSlots(null); setSlotsFailed(true); } })
      .finally(() => { if (!cancelled) setSlotsLoading(false); });
    return () => { cancelled = true; };
  }, [slug, info, dateISO]);

  const slotTimeLabel = useMemo(() => {
    if (!info) return (iso: string) => iso;
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: info.timezone, hour: "2-digit", minute: "2-digit" });
    return (iso: string) => fmt.format(new Date(iso));
  }, [info]);

  const bookingWindow = useMemo(() => {
    // Slot mode: the server gave us the exact start instant.
    if (selectedStart) {
      const start = new Date(selectedStart);
      return { startAt: start.toISOString(), endAt: new Date(start.getTime() + durationHours * 3600_000).toISOString() };
    }
    // Fallback mode (slot fetch failed): manual wall-time entry.
    if (!slotsFailed || !startLocal || !info) return null;
    try {
      const start = wallTimeToInstant(startLocal, info.timezone);
      if (isNaN(start.getTime())) return null;
      const end = new Date(start.getTime() + durationHours * 3600_000);
      return { startAt: start.toISOString(), endAt: end.toISOString() };
    } catch {
      return null;
    }
  }, [selectedStart, slotsFailed, startLocal, durationHours, info]);

  const checkAvailability = async () => {
    if (!bookingWindow) return;
    setChecking(true);
    setError(null);
    setAvailability(null);
    try {
      const res = await fetch("/api/public/hourly/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelSlug: slug, ...bookingWindow }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not check availability");
      setAvailability(data);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setChecking(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!bookingWindow) return;
    if (!guestEmail.trim() || !guestPhone.trim()) {
      setError("Enter both your email AND mobile number — the door code is sent to both.");
      return;
    }
    // "Now"-slot: the instant was frozen when the slot list loaded — a guest
    // who lingers on the page would book a stale (possibly too-old) start.
    // Re-anchor to the ACTUAL submit moment so access runs from right now.
    let effectiveWindow = bookingWindow;
    const selectedSlot = selectedStart && slots ? slots.find(s => s.startAt === selectedStart) : null;
    if (selectedSlot?.now) {
      const freshStart = new Date();
      // Full package from RIGHT NOW, end rounded UP to the next whole hour
      // (12:47 + 3h → 16:00) — the server applies the same rule.
      const rawEnd = freshStart.getTime() + durationHours * 3600_000;
      effectiveWindow = {
        startAt: freshStart.toISOString(),
        endAt: new Date(Math.ceil(rawEnd / 3600_000) * 3600_000).toISOString(),
      };
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/public/hourly/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hotelSlug: slug,
          guestName: guestName.trim(),
          guestEmail: guestEmail.trim() || undefined,
          guestPhone: guestPhone.trim() || undefined,
          ...effectiveWindow,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Booking failed");
      if (!data.checkoutUrl) throw new Error("Payment could not be started");

      if (isKiosk) {
        // Wall tablet: stay on this page, show the payment QR and poll.
        const product = info?.products.find(p => p.hours === durationHours);
        const dkk = product ? product.price : info?.pricePerHour != null ? durationHours * info.pricePerHour : null;
        setKioskPay({ bookingId: data.bookingId, checkoutUrl: data.checkoutUrl, dkk });
        setSubmitting(false);
        return;
      }
      if (data.provider === "mews" && data.confirmationUrl) {
        // MEWS' payment page has no redirect-back: open payment in a new tab
        // and turn THIS tab into the confirmation page, which polls until the
        // payment completes. If the popup is blocked, pay in this tab instead
        // (the code still arrives by SMS/email within a few minutes).
        const paymentTab = window.open(data.checkoutUrl, "_blank");
        if (paymentTab) {
          window.location.href = data.confirmationUrl;
        } else {
          window.location.href = data.checkoutUrl;
        }
      } else {
        window.location.href = data.checkoutUrl; // → Stripe hosted checkout (redirects back)
      }
    } catch (e: any) {
      setError(e.message);
      setSubmitting(false);
    }
  };

  // ── Confirmation view (Stripe redirect back, or kiosk QR payment) ─────────
  if (returnedBookingId || kioskPay) {
    const confirmed = bookingStatus?.status === "confirmed" && !!bookingStatus.code;
    const failed = !!bookingStatus && ["cancelled", "expired"].includes(bookingStatus.status);
    const waiting = !confirmed && !failed && !pollTimedOut;
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4" style={rootStyle}>
        {isKiosk && (
          <div className="w-full max-w-md mb-3">
            <Button
              variant="outline"
              onClick={() => { window.location.href = `/${slug}/info`; }}
              data-testid="button-kiosk-back"
            >
              ← Back to main menu
            </Button>
          </div>
        )}
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            {confirmed ? (
              <CheckCircle2 className="w-12 h-12 mx-auto text-green-600" />
            ) : waiting ? (
              <Loader2 className="w-12 h-12 mx-auto animate-spin text-muted-foreground" />
            ) : (
              <AlertCircle className="w-12 h-12 mx-auto text-destructive" />
            )}
            <CardTitle>
              {confirmed ? "You're in!" : waiting ? "Confirming your payment…" : failed ? "Something went wrong" : "Taking longer than expected"}
            </CardTitle>
            <CardDescription>
              {confirmed
                ? "Your door code has also been sent by SMS and email."
                : waiting
                  ? (kioskPay
                      ? `Scan the QR code with your phone camera and pay${kioskPay.dkk != null ? ` ${kioskPay.dkk} DKK${eur(kioskPay.dkk)}` : ""} there — this screen updates automatically.`
                      : "If payment opened in another tab, complete it there — this page updates automatically.")
                  : failed
                    ? "The booking could not be completed. If you paid, the amount will be refunded — please contact the hotel."
                    : "Check your SMS/email for the door code, or contact the hotel."}
            </CardDescription>
          </CardHeader>
          {waiting && kioskPay && (
            <CardContent className="text-center space-y-3">
              <div className="flex justify-center rounded-lg bg-white p-4" data-testid="kiosk-payment-qr">
                <QRCodeSVG value={kioskPay.checkoutUrl} size={220} />
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => { window.location.href = `/${slug}/info`; }}
              >
                Cancel / start over
              </Button>
            </CardContent>
          )}
          {confirmed && bookingStatus && (
            <CardContent className="text-center space-y-3">
              <div>
                <div className="text-sm text-muted-foreground">Capsule</div>
                <div className="text-xl font-semibold">{bookingStatus.capsule}</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Door code</div>
                <div className="text-4xl font-mono font-bold tracking-widest">{bookingStatus.code}#</div>
                <div className="text-xs text-muted-foreground mt-1">Works on the entrance doors and your capsule</div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Valid</div>
                <div className="font-medium">
                  {info ? `${fmtInTz(bookingStatus.startAt, info.timezone)} – ${fmtInTz(bookingStatus.endAt, info.timezone)}` : ""}
                </div>
              </div>
            </CardContent>
          )}
        </Card>
      </div>
    );
  }

  // ── Booking form ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4" style={rootStyle}>
      {isKiosk && (
        <div className="w-full max-w-md mb-3">
          <Button
            variant="outline"
            onClick={() => { window.location.href = `/${slug}/info`; }}
            data-testid="button-kiosk-back"
          >
            ← Back to main menu
          </Button>
        </div>
      )}
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          {theme?.logoUrl ? (
            <div className="w-16 h-16 rounded-2xl bg-[var(--brand,#dc2626)] flex items-center justify-center mx-auto mb-1">
              <img src={theme.logoUrl} alt={info?.hotelName || ""} className="h-9 w-auto" />
            </div>
          ) : (
            <Clock className="w-10 h-10 mx-auto text-muted-foreground" />
          )}
          <CardTitle>Book a capsule by the hour</CardTitle>
          <CardDescription>
            {hotelInfo?.name || info?.hotelName || ""}
            {info && info.products.length > 0
              ? ` · ${info.products.map(p => `${p.hours} h ${p.price} ${info.currency ?? "DKK"}${eur(p.price)}`).join(" · ")}`
              : info?.pricePerHour ? ` · ${info.pricePerHour} ${info.currency}/hour` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {wasCancelled && (
            <div className="mb-4 p-3 rounded-md bg-muted text-sm text-muted-foreground">
              Payment was cancelled — your slot was not booked.
            </div>
          )}
          {infoError ? (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4" /> {infoError}
            </div>
          ) : info && !info.paymentConfigured ? (
            <div className="p-3 rounded-md bg-muted text-sm text-muted-foreground">
              Online booking is not available yet — please contact the hotel.
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label htmlFor="name">Your name</Label>
                <Input id="name" required minLength={2} value={guestName} onChange={e => setGuestName(e.target.value)} data-testid="input-public-name" />
              </div>
              <div className="grid grid-cols-1 gap-3">
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" required value={guestEmail} onChange={e => setGuestEmail(e.target.value)} data-testid="input-public-email" />
                </div>
                <div>
                  <Label htmlFor="phone">Mobile (with country code, e.g. +45…)</Label>
                  <Input id="phone" required value={guestPhone} onChange={e => setGuestPhone(e.target.value)} data-testid="input-public-phone" />
                </div>
              </div>
              {info && info.products.length > 0 && (
                <div>
                  <Label>Choose your stay</Label>
                  <div className="grid grid-cols-2 gap-2 mt-1" data-testid="grid-public-products">
                    {info.products.map((p, idx) => (
                      <button
                        key={p.hours}
                        type="button"
                        onClick={() => {
                          setDurationHours(p.hours);
                          setAvailability(null);
                          if (selectedStart && slots && !(slots.find(s => s.startAt === selectedStart)?.maxHours! >= p.hours)) {
                            setSelectedStart(null);
                          }
                        }}
                        className={`rounded-lg border p-3 text-left transition-colors ${
                          // Odd product count: the last card spans the full row
                          // instead of sitting alone at half width (3 packages
                          // since 26/7: 3h/6h/9h).
                          info.products.length % 2 === 1 && idx === info.products.length - 1 ? "col-span-2" : ""
                        } ${
                          durationHours === p.hours
                            ? "border-[var(--brand,#dc2626)] bg-[var(--brand-tint,#fee2e2)] ring-1 ring-[var(--brand,#dc2626)]"
                            : "border-input bg-background hover:bg-muted"
                        }`}
                      >
                        <div className="text-lg font-bold">{p.hours} hours</div>
                        <div className="text-sm text-muted-foreground">{p.price} {info.currency ?? "DKK"}{eur(p.price)}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className={`grid ${info && info.products.length > 0 ? "grid-cols-1" : "grid-cols-2"} gap-3`}>
                <div>
                  <Label htmlFor="date">Date</Label>
                  <select
                    id="date"
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={dateISO ?? ""}
                    onChange={e => { setDateISO(e.target.value); setAvailability(null); }}
                    data-testid="select-public-date"
                  >
                    {dateOptions.map(d => (
                      <option key={d.iso} value={d.iso}>{d.label}</option>
                    ))}
                  </select>
                </div>
                {(!info || info.products.length === 0) && (
                  <div>
                    <Label htmlFor="duration">Duration</Label>
                    <select
                      id="duration"
                      className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                      value={durationHours}
                      onChange={e => {
                        const h = Number(e.target.value);
                        setDurationHours(h);
                        setAvailability(null);
                        // Keep the chosen start only if it still fits the new duration.
                        if (selectedStart && slots && !(slots.find(s => s.startAt === selectedStart)?.maxHours! >= h)) {
                          setSelectedStart(null);
                        }
                      }}
                      data-testid="select-public-duration"
                    >
                      {DURATIONS.filter(h => !info || h <= info.maxHours).map(h => (
                        <option key={h} value={h}>{h} hour{h > 1 ? "s" : ""}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {slotsLoading && (
                <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading available times…</div>
              )}
              {slots && (
                <div>
                  <Label>Start time</Label>
                  {slots.filter(s => s.maxHours >= durationHours).length === 0 ? (
                    <p className="text-sm text-muted-foreground mt-1">
                      No {durationHours}-hour slots free on this date — try a shorter duration or another date.
                    </p>
                  ) : (
                    <div className="grid grid-cols-4 gap-2 mt-1" data-testid="grid-public-slots">
                      {slots.filter(s => s.maxHours >= durationHours).map(s => (
                        <button
                          key={s.startAt}
                          type="button"
                          onClick={() => { setSelectedStart(s.startAt); setAvailability(null); }}
                          className={`h-9 rounded-md border text-sm font-medium transition-colors ${
                            selectedStart === s.startAt
                              ? "bg-[var(--brand,#dc2626)] text-white border-[var(--brand,#dc2626)]"
                              : s.now
                                ? "bg-[var(--brand-tint,#fee2e2)] border-[var(--brand,#dc2626)] hover:bg-muted"
                                : "bg-background border-input hover:bg-muted"
                          }`}
                          data-testid={s.now ? "slot-start-now" : undefined}
                        >
                          {s.now ? "Now" : slotTimeLabel(s.startAt)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {slotsFailed && (
                <div>
                  <Label htmlFor="start">From</Label>
                  <Input id="start" type="datetime-local" required value={startLocal}
                    onChange={e => { setStartLocal(e.target.value); setAvailability(null); }} data-testid="input-public-start" />
                </div>
              )}
              {info && (
                <p className="text-xs text-muted-foreground">Times are local hotel time ({info.timezone}).</p>
              )}
              {selectedStart && info && (() => {
                const product = info.products.find(p => p.hours === durationHours);
                const total = product ? product.price : info.pricePerHour != null ? durationHours * info.pricePerHour : null;
                return total != null ? (
                  <p className="text-sm font-medium" data-testid="text-public-price">
                    Total: {total} {info.currency ?? "DKK"}{eur(total)} ({durationHours} hour{durationHours > 1 ? "s" : ""})
                  </p>
                ) : null;
              })()}

              {availability && (!info || info.products.length === 0) && (
                <div className={`p-3 rounded-md text-sm ${availability.count > 0 ? "bg-green-50 text-green-800" : "bg-muted text-muted-foreground"}`}>
                  {availability.count > 0
                    ? <>Available · {availability.price ? `Total: ${availability.price.total} ${availability.price.currency}` : ""}</>
                    : "Sorry — no capsules free in that time slot."}
                </div>
              )}

              {error && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" /> {error}
                </div>
              )}

              <div className="flex gap-2">
                {(!info || info.products.length === 0) && (
                  <Button type="button" variant="outline" className="flex-1" disabled={!bookingWindow || checking} onClick={checkAvailability} data-testid="button-public-check">
                    {checking ? <Loader2 className="w-4 h-4 animate-spin" /> : "Check availability"}
                  </Button>
                )}
                <Button
                  type="submit"
                  className="flex-1 bg-[var(--brand,#dc2626)] hover:bg-[var(--brand-dark,#b91c1c)] text-white h-11"
                  disabled={!bookingWindow || submitting || (availability !== null && availability.count === 0)}
                  data-testid="button-public-book"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <><KeyRound className="w-4 h-4 mr-1" /> Book & pay</>}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground text-center">
                Payment is handled on a secure hosted payment page. Your door code arrives right after payment.
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
