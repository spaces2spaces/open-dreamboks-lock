import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useParams } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, Sparkles, AlarmClockPlus, AlertCircle, CheckCircle2, DoorOpen } from "lucide-react";
import { type GuestTheme, guestThemeStyle, useGuestFont, useFavicon } from "@/lib/guest-theme";

// ── Guest extras — buy early check-in AND late check-out from your phone ─────
// Supersedes ExtendStayPage (27/7): one door-code lookup shows every offer the
// stay is eligible for, as product cards. Served on BOTH /:hotel/extras (new,
// used by marketing SMS links) and /:hotel/extend (old email links). Payment
// is the MEWS payment-request URL (opened directly) + the shared status poll.

interface HotelInfo { name: string; slug: string; theme?: GuestTheme | null }

interface EcOption { from: string; label: string; hours: number; dkk: number; eur: number }
interface EcQuote {
  ok: boolean;
  reason?: string;
  inspected?: boolean;
  firstName?: string | null;
  capsule?: string;
  options?: EcOption[];
  hours?: number;
  dkk?: number;
  eur?: number;
  validFrom?: string;
}

interface LcOption { until: string; label: string; hours: number; dkk: number; eur: number }
interface LcQuote { ok: boolean; reason?: string; firstName?: string | null; capsule?: string; options?: LcOption[] }

const lcReasonMessage = (reason: string): string => {
  switch (reason) {
    case "not_ready": return "Late check-out isn't available for your booking yet.";
    case "already_active": return "The checkout time has already passed.";
    case "too_early": return "Late check-out opens closer to your departure day.";
    case "not_available": return "Late check-out isn't available for your capsule today — it's booked right after your stay.";
    case "mews_unavailable": return "Payment is starting up — please try again in a minute.";
    case "disabled": return "";
    default: return "";
  }
};

const ecReasonMessage = (reason: string): string => {
  switch (reason) {
    case "already_checked_in": return "You're already checked in — your door code works.";
    case "already_active": return "Your door code is already active — just type it on the keypad.";
    case "already_bought": return "You've already bought early check-in — your door code starts working at the time you picked.";
    case "too_early": return "Early check-in opens 72 hours before your arrival.";
    case "occupied": return "Your capsule is still occupied by the previous guest — early check-in opens as soon as they've checked out.";
    case "mews_unavailable": return "Payment is starting up — please try again in a minute.";
    case "disabled": return "";
    default: return "";
  }
};

export default function GuestExtrasPage() {
  const params = useParams<{ hotel: string }>();
  const slug = params.hotel || "";

  const [hotelInfo, setHotelInfo] = useState<HotelInfo | null>(null);
  // ?offer=ec|lc (campaign links, owner 5/8): the page shows ONLY that offer.
  // Manual lookups (no param) keep showing everything the stay is eligible for.
  const [offerScope] = useState<"ec" | "lc" | null>(() => {
    const o = new URLSearchParams(window.location.search).get("offer");
    return o === "ec" || o === "lc" ? o : null;
  });
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [looked, setLooked] = useState(false);
  const [ecQuote, setEcQuote] = useState<EcQuote | null>(null);
  const [lcQuote, setLcQuote] = useState<LcQuote | null>(null);
  const [paying, setPaying] = useState<string | null>(null); // "ec" or option.until
  const [payment, setPayment] = useState<{ kind: "ec" | "lc"; id: string; paymentUrl: string; label: string; dkk: number } | null>(null);
  const [paid, setPaid] = useState<{ kind: "ec" | "lc"; until: string | null } | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    document.title = "Your stay — extras";
    if (!slug) return;
    fetch(`/api/public/hotel-info/${slug}`)
      .then(res => res.json())
      .then(data => { if (data?.name) { setHotelInfo(data); document.title = `Extras – ${data.name}`; } })
      .catch(() => {});
  }, [slug]);

  const theme = hotelInfo?.theme || null;
  const baseStyle = guestThemeStyle(theme);
  const rootStyle = theme?.font ? { ...baseStyle, fontFamily: "var(--guest-font)" } : baseStyle;
  useGuestFont(theme?.font);
  useFavicon(theme?.logoUrl, theme?.brand || null);

  const timeLabel = useMemo(() => (iso: string) =>
    new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)), []);

  const runLookup = async (c: string) => {
    if (!/^\d{4,8}$/.test(c)) { setError("Please type the 4-digit door code from your SMS or email."); return; }
    setLoading(true);
    setError(null);
    setEcQuote(null);
    setLcQuote(null);
    setLooked(false);
    try {
      // source: funnel marker only (server logs extras vs kiosk lookups)
      const body = JSON.stringify({ hotelSlug: slug, doorCode: c, source: "extras" });
      const opts = { method: "POST", headers: { "Content-Type": "application/json" }, body };
      const [ecRes, lcRes] = await Promise.all([
        offerScope !== "lc" ? fetch("/api/public/early-checkin/lookup", opts) : Promise.resolve(null),
        offerScope !== "ec" ? fetch("/api/public/late-checkout/lookup", opts) : Promise.resolve(null),
      ]);
      if (ecRes?.status === 429 || lcRes?.status === 429) { setError("Too many attempts — please wait a bit."); return; }
      const ec = ecRes ? await ecRes.json() : null;
      const lc = lcRes ? await lcRes.json() : null;
      if ((!ec || ec.reason === "not_found") && (!lc || lc.reason === "not_found")) {
        setError("We couldn't find a booking with that door code. Please check the code in your SMS or email.");
        return;
      }
      if (ec?.reason === "owing" || lc?.reason === "owing") {
        setError("There's an outstanding balance on your booking. Please settle it via the payment link in your email first.");
        return;
      }
      setEcQuote(ec);
      setLcQuote(lc);
      setLooked(true);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const lookup = (e: FormEvent) => {
    e.preventDefault();
    runLookup(code.trim());
  };

  // Marketing SMS links carry ?code=<door code> (the guest already received it
  // by SMS) — pre-fill and look up immediately so the offers open in one tap.
  useEffect(() => {
    const prefill = new URLSearchParams(window.location.search).get("code")?.trim();
    if (prefill && /^\d{4,8}$/.test(prefill)) {
      setCode(prefill);
      runLookup(prefill);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const payEc = async (option: EcOption) => {
    setPaying(`ec:${option.from}`);
    setError(null);
    try {
      const res = await fetch("/api/public/early-checkin/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelSlug: slug, doorCode: code.trim(), from: option.from }),
      });
      if (res.status === 429) { setError("Too many attempts — please wait a bit."); return; }
      const data = await res.json();
      if (!data.ok) { setError(ecReasonMessage(data.reason) || "Early check-in isn't available right now. Please try again in a moment."); return; }
      const label = option.label === "now" ? "early check-in" : `early check-in from ${option.label}`;
      setPayment({ kind: "ec", id: data.id, paymentUrl: data.paymentUrl, label, dkk: data.dkk });
      window.open(data.paymentUrl, "_blank");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPaying(null);
    }
  };

  const payLc = async (option: LcOption) => {
    setPaying(option.until);
    setError(null);
    try {
      const res = await fetch("/api/public/late-checkout/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelSlug: slug, doorCode: code.trim(), until: option.until }),
      });
      if (res.status === 429) { setError("Too many attempts — please wait a bit."); return; }
      const data = await res.json();
      if (!data.ok) { setError(lcReasonMessage(data.reason) || "Late check-out isn't available right now. Please try again in a moment."); return; }
      setPayment({ kind: "lc", id: data.id, paymentUrl: data.paymentUrl, label: `late check-out until ${option.label}`, dkk: option.dkk });
      window.open(data.paymentUrl, "_blank");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setPaying(null);
    }
  };

  // Shared status poll (serves both kinds; the sweep completes MEWS-paid rows
  // even if this tab dies).
  useEffect(() => {
    if (!payment || paid || expired) return;
    const startedAt = Date.now();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/public/early-checkin/${payment.id}?hotel=${encodeURIComponent(slug)}`);
        if (res.ok) {
          const data = await res.json();
          if (data.granted) { setPaid({ kind: payment.kind, until: data.receipt?.accessUntil ?? null }); return; }
          if (data.status === "expired") { setExpired(true); return; }
        }
      } catch { /* transient */ }
      if (Date.now() - startedAt > 40 * 60_000) { setExpired(true); return; }
      timer = setTimeout(poll, Date.now() - startedAt < 2 * 60_000 ? 3000 : 15_000);
    };
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [payment, paid, expired, slug]);

  const firstName = ecQuote?.firstName || lcQuote?.firstName || null;
  const ecCard = looked && ecQuote?.ok;
  const lcCard = looked && lcQuote?.ok && (lcQuote.options?.length ?? 0) > 0;
  const cardNotes = looked
    ? [ecQuote?.reason ? ecReasonMessage(ecQuote.reason) : "", lcQuote?.reason ? lcReasonMessage(lcQuote.reason) : ""].filter(Boolean)
    : [];

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4" style={rootStyle}>
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          {theme?.logoUrl ? (
            <div className="w-16 h-16 rounded-2xl bg-[var(--brand,#dc2626)] flex items-center justify-center mx-auto mb-1">
              <img src={theme.logoUrl} alt={hotelInfo?.name || ""} className="h-9 w-auto" />
            </div>
          ) : (
            <Sparkles className="w-10 h-10 mx-auto text-muted-foreground" />
          )}
          <CardTitle>Make your stay better</CardTitle>
          <CardDescription>
            {hotelInfo?.name || ""} · check in early or sleep longer — your door code stays exactly the same.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {paid ? (
            <div className="text-center space-y-3" data-testid="extras-paid">
              <CheckCircle2 className="w-12 h-12 mx-auto text-green-600" />
              <p className="text-lg font-semibold">
                {paid.kind === "ec" ? "You're in — enjoy your early check-in!" : "Late check-out confirmed!"}
              </p>
              <p className="text-sm text-muted-foreground">
                {paid.kind === "ec"
                  ? "Your same door code works right now — on the entrance doors and your capsule."
                  : <>Your same door code now works until <span className="font-semibold text-foreground">{paid.until ? timeLabel(paid.until) : ""}</span>. Sleep well!</>}
              </p>
            </div>
          ) : expired ? (
            <div className="text-center space-y-3">
              <AlertCircle className="w-12 h-12 mx-auto text-destructive" />
              <p className="text-sm">The payment window expired — no money was taken. Look up your code to try again.</p>
              <Button variant="outline" className="w-full" onClick={() => { setPayment(null); setExpired(false); setLooked(false); setEcQuote(null); setLcQuote(null); }}>
                Start over
              </Button>
            </div>
          ) : payment ? (
            <div className="text-center space-y-3">
              <Loader2 className="w-10 h-10 mx-auto animate-spin text-muted-foreground" />
              <p className="text-sm">
                Complete the payment of <b>{payment.dkk} DKK</b> for {payment.label} in the tab that just opened — this page updates automatically.
              </p>
              <a href={payment.paymentUrl} target="_blank" rel="noreferrer" className="text-sm underline text-[var(--brand,#2563eb)]">
                Payment page didn't open? Tap here
              </a>
            </div>
          ) : looked ? (
            <div className="space-y-3">
              {firstName && <p className="text-center text-muted-foreground">Hi {firstName}!</p>}

              {ecCard && (
                <div className="rounded-lg border p-4 space-y-2" data-testid="card-early-checkin">
                  <div className="flex items-center gap-2 font-semibold">
                    <DoorOpen className="w-4 h-4" /> Early check-in — get in earlier
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Capsule {ecQuote!.capsule} · your door code stays the same, it just starts working earlier.
                  </p>
                  {!ecQuote!.inspected && (
                    <p className="text-xs text-muted-foreground">
                      Your capsule isn't ready yet — housekeeping makes it a priority the moment you pay.
                    </p>
                  )}
                  {(ecQuote!.options ?? [{ from: "", label: "now", hours: ecQuote!.hours ?? 1, dkk: ecQuote!.dkk ?? 0, eur: ecQuote!.eur ?? 0 }]).map(o => (
                    <Button
                      key={o.from || "now"}
                      className="w-full h-11 bg-[var(--brand,#dc2626)] hover:bg-[var(--brand-dark,#b91c1c)] text-white"
                      disabled={paying !== null}
                      onClick={() => payEc(o)}
                      data-testid="button-buy-early-checkin"
                    >
                      {paying === `ec:${o.from}`
                        ? <Loader2 className="w-4 h-4 animate-spin" />
                        : o.label === "now"
                          ? `Check in now — ${o.dkk} kr (≈ €${o.eur})`
                          : `From ${o.label} — ${o.dkk} kr (≈ €${o.eur})`}
                    </Button>
                  ))}
                </div>
              )}

              {lcCard && (
                <div className="rounded-lg border p-4 space-y-2" data-testid="card-late-checkout">
                  <div className="flex items-center gap-2 font-semibold">
                    <AlarmClockPlus className="w-4 h-4" /> Late check-out — sleep longer
                  </div>
                  {(lcQuote!.options ?? []).map(o => (
                    <Button
                      key={o.until}
                      className="w-full h-11 bg-[var(--brand,#dc2626)] hover:bg-[var(--brand-dark,#b91c1c)] text-white"
                      disabled={paying !== null}
                      onClick={() => payLc(o)}
                    >
                      {paying === o.until ? <Loader2 className="w-4 h-4 animate-spin" /> : `Until ${o.label} — ${o.dkk} kr (≈ €${o.eur})`}
                    </Button>
                  ))}
                </div>
              )}

              {!ecCard && !lcCard && (
                <p className="text-sm text-muted-foreground text-center py-4" data-testid="extras-none">
                  No extras are available for your stay right now.
                </p>
              )}
              {cardNotes.map((n, i) => (
                <p key={i} className="text-xs text-muted-foreground text-center">{n}</p>
              ))}
              {error && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" /> {error}
                </div>
              )}
              <Button variant="ghost" className="w-full" onClick={() => { setLooked(false); setEcQuote(null); setLcQuote(null); setError(null); }}>
                Look up a different code
              </Button>
            </div>
          ) : (
            <form onSubmit={lookup} className="space-y-3">
              <div>
                <Label htmlFor="code">Your door code</Label>
                <Input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="e.g. 4711"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  className="text-center text-2xl font-mono tracking-widest h-12"
                  data-testid="input-extras-code"
                />
                <p className="text-xs text-muted-foreground mt-1">The 4-digit code from your booking SMS/email.</p>
              </div>
              {error && (
                <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm flex items-center gap-2">
                  <AlertCircle className="w-4 h-4" /> {error}
                </div>
              )}
              <Button type="submit" className="w-full h-11 bg-[var(--brand,#dc2626)] hover:bg-[var(--brand-dark,#b91c1c)] text-white" disabled={loading}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Show my offers"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
