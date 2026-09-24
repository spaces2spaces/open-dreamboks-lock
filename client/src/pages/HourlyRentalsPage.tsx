import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { hourlyAPI, type DayAvailabilityDTO, type HourlyBookingDTO } from "@/lib/api";
import { priorityScore } from "@shared/hourly-priority";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// ── Time Booking Inventory ───────────────────────────────────────────────────

/** Local (browser-tz) YYYY-MM-DD — toISOString would flip the date around midnight. */
function isoLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hourLabel(h: number): string {
  return `${String(h).padStart(2, "0")}.00`;
}

type RowStatus = "available" | "partial" | "unavailable" | "blocked";

const HOUSEKEEPING_BADGE: Record<string, { label: string; cls: string }> = {
  Inspected: { label: "Inspected", cls: "bg-green-100 text-green-800" },
  Clean: { label: "Clean", cls: "bg-sky-100 text-sky-800" },
  Dirty: { label: "Dirty", cls: "bg-amber-100 text-amber-800" },
  OutOfService: { label: "Out of service", cls: "bg-red-100 text-red-800" },
  OutOfOrder: { label: "Out of order", cls: "bg-red-100 text-red-800" },
};

function HousekeepingBadge({ state }: { state: string | null }) {
  if (!state) return <span className="text-muted-foreground">—</span>;
  const b = HOUSEKEEPING_BADGE[state] ?? { label: state, cls: "bg-gray-100 text-gray-600" };
  return <Badge variant="outline" className={`${b.cls} border-transparent`}>{b.label}</Badge>;
}

const STATUS_BADGE: Record<RowStatus, { label: string; cls: string }> = {
  available: { label: "Available", cls: "bg-green-100 text-green-800" },
  partial: { label: "Partially available", cls: "bg-amber-100 text-amber-800" },
  unavailable: { label: "Unavailable", cls: "bg-gray-200 text-gray-600" },
  blocked: { label: "Blocked", cls: "bg-red-100 text-red-800" },
};

// ── Create booking dialog (phase 2) ─────────────────────────────────────────

interface CreateBookingTarget {
  roomId: string;
  label: string;
  dateLabel: string;
  windowLabel: string;
  startIso: string;
  endIso: string;
  hours: number;
}

function CreateBookingDialog({
  target,
  onClose,
  onBooked,
}: {
  target: CreateBookingTarget | null;
  onClose: () => void;
  onBooked: () => void;
}) {
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [amount, setAmount] = useState("");
  const [skipPayment, setSkipPayment] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    mode: "confirmed" | "pending_payment";
    bookingId: string;
    code?: string | null;
    warnings?: string[];
    paymentUrl?: string;
  } | null>(null);
  const [paid, setPaid] = useState<{ code: string | null; warnings: string[] } | null>(null);
  const [expired, setExpired] = useState(false);

  const { data: pricing } = useQuery({ queryKey: ["hourly-pricing"], queryFn: hourlyAPI.getPricing, enabled: !!target });
  const perHour = pricing?.perHour ?? 75;
  const currency = pricing?.currency ?? "DKK";
  const suggested = target ? target.hours * perHour : 0;

  // Reset the form whenever a new capsule/window is opened.
  useEffect(() => {
    setGuestName(""); setGuestPhone(""); setGuestEmail("");
    setAmount(""); setSkipPayment(false);
    setError(null); setResult(null); setPaid(null); setExpired(false);
  }, [target?.roomId, target?.startIso, target?.endIso]);

  const createMutation = useMutation({
    mutationFn: () =>
      hourlyAPI.createBookingWithPayment({
        guestName: guestName.trim(),
        guestEmail: guestEmail.trim() || undefined,
        guestPhone: guestPhone.trim() || undefined,
        startAt: target!.startIso,
        endAt: target!.endIso,
        roomId: target!.roomId,
        amount: amount.trim() || undefined,
        currency,
        skipPayment,
      }),
    onSuccess: (data) => {
      setResult(data);
      if (data.mode === "confirmed") {
        setPaid({ code: data.code ?? null, warnings: data.warnings ?? [] });
        onBooked();
      }
    },
    onError: (e: any) => setError(e.message),
  });

  // Poll payment status while the QR is on screen.
  useEffect(() => {
    if (!result || result.mode !== "pending_payment" || paid || expired) return;
    const interval = window.setInterval(async () => {
      try {
        const status = await hourlyAPI.getBookingStatus(result.bookingId);
        if (status.status === "confirmed") {
          setPaid({ code: status.code, warnings: status.warnings });
          onBooked();
        } else if (status.status === "expired" || status.status === "cancelled") {
          setExpired(true);
        }
      } catch { /* transient — next tick retries */ }
    }, 4000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.bookingId, result?.mode, paid, expired]);

  if (!target) return null;

  const canSubmit =
    guestName.trim().length > 0 &&
    (skipPayment || guestPhone.trim().length > 0 || guestEmail.trim().length > 0) &&
    !createMutation.isPending;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create booking — Capsule {target.label}</DialogTitle>
          <DialogDescription>
            {target.dateLabel} · {target.windowLabel} ({target.hours} hour{target.hours === 1 ? "" : "s"})
          </DialogDescription>
        </DialogHeader>

        {paid ? (
          <div className="space-y-3" data-testid="cb-confirmed">
            <p className="text-lg font-semibold text-green-700">Booking confirmed ✅</p>
            {paid.code && (
              <p className="text-2xl font-mono font-bold tracking-widest">{paid.code}#</p>
            )}
            <p className="text-sm text-muted-foreground">
              The door code has been sent to the guest and works only in the selected window.
            </p>
            {(paid.warnings ?? []).length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {paid.warnings.map((w, i) => <div key={i}>{w}</div>)}
              </div>
            )}
            <Button className="w-full" onClick={onClose}>Close</Button>
          </div>
        ) : expired ? (
          <div className="space-y-3">
            <p className="text-sm text-red-600">Payment window expired — no money was taken. The slot has been released.</p>
            <Button className="w-full" variant="outline" onClick={onClose}>Close</Button>
          </div>
        ) : result?.mode === "pending_payment" ? (
          <div className="space-y-3 text-center" data-testid="cb-qr">
            <p className="text-sm">Scan to pay <b>{amount.trim() || suggested} {currency}</b></p>
            <div className="flex justify-center">
              <QRCodeSVG value={result.paymentUrl!} size={220} level="M" />
            </div>
            <p className="text-xs text-muted-foreground">
              The payment link was also sent to the guest{guestPhone.trim() ? " by SMS" : ""}{guestEmail.trim() ? " and email" : ""}.
              This dialog confirms automatically once the payment lands — the door code is then sent to the guest.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {pricing && !pricing.mewsEnabled && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                MEWS reservations are currently disabled — the booking only blocks in this system. Block the capsule manually in MEWS if needed.
              </div>
            )}
            <Input placeholder="Guest name *" value={guestName} onChange={(e) => setGuestName(e.target.value)} data-testid="cb-name" />
            <div className="grid grid-cols-2 gap-3">
              <Input placeholder="Phone (+45…)" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} data-testid="cb-phone" />
              <Input placeholder="Email" type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} data-testid="cb-email" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Amount ({currency}) — {target.hours} h × {perHour} = {suggested}</label>
              <Input placeholder={String(suggested)} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} data-testid="cb-amount" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={skipPayment} onChange={(e) => setSkipPayment(e.target.checked)} data-testid="cb-skip" />
              Skip payment (complimentary / paid in cash)
            </label>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button className="w-full" disabled={!canSubmit} onClick={() => { setError(null); createMutation.mutate(); }} data-testid="cb-submit">
              {createMutation.isPending
                ? "Creating…"
                : skipPayment
                  ? "Create booking & send code"
                  : `Create booking & request ${amount.trim() || suggested} ${currency}`}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TimeBookingInventoryCard() {
  // Rolling 7-day horizon: today + the following six days.
  const days = useMemo(() => {
    const out: { iso: string; label: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const weekday = d.toLocaleDateString("da-DK", { weekday: "long" });
      const label = `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${d.getDate()}. ${d.toLocaleDateString("da-DK", { month: "long" })}`;
      out.push({ iso: isoLocalDate(d), label });
    }
    return out;
  }, []);

  const [date, setDate] = useState(days[0].iso);
  const [fromHour, setFromHour] = useState(12);
  // Owner decision 24/7: pick a START time + number of HOURS (max 12) instead
  // of an end time — crossing midnight then needs no special picker (23 + 5h
  // simply ends 04.00 next day). toHour stays the internal representation
  // (can exceed 24) so the two-day availability check below is unchanged.
  const [hours, setHours] = useState(6);
  const MAX_BOOKING_HOURS = 12;
  const toHour = fromHour + hours;
  const [showOthers, setShowOthers] = useState(false);
  const [bookingTarget, setBookingTarget] = useState<CreateBookingTarget | null>(null);

  const { data: overview, isLoading, isFetching, isError } = useQuery<DayAvailabilityDTO>({
    queryKey: ["hourly-availability", date],
    queryFn: () => hourlyAPI.getAvailabilityOverview(date),
  });

  // Cross-midnight windows (To later than 24.00): the after-midnight part
  // lives in the NEXT day's picture — fetch it and require the capsule free
  // in BOTH days (same stitching rule as the public slot endpoint).
  const crossing = toHour > 24;
  const nextDate = useMemo(() => {
    const d = new Date(`${date}T12:00:00`);
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, [date]);
  const { data: nextOverview } = useQuery<DayAvailabilityDTO>({
    queryKey: ["hourly-availability", nextDate],
    queryFn: () => hourlyAPI.getAvailabilityOverview(nextDate),
    enabled: crossing,
  });

  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Pool membership is per SPACE (rooms.hourly_pool) but the row is the
  // physical capsule — flip every twin space so the group state is unambiguous.
  const poolMutation = useMutation({
    mutationFn: async ({ roomIds, on }: { roomIds: string[]; on: boolean; label: string }) => {
      for (const id of roomIds) await hourlyAPI.setPool(id, on);
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ["hourly-availability"] });
      toast({
        title: vars.on ? `Capsule ${vars.label} added to priority` : `Capsule ${vars.label} removed from priority`,
        description: vars.on
          ? "Remember to BLOCK the capsule in MEWS so it isn't also sold per night."
          : "Remember to unblock the capsule in MEWS if it should be sold per night again.",
      });
    },
    onError: (e: any) => toast({ title: "Priority update failed", description: e.message, variant: "destructive" }),
  });

  const poolToggleButton = (row: { roomIds: string[]; label: string; hourlyPool: boolean }) => (
    <button
      type="button"
      className="block text-xs text-muted-foreground underline underline-offset-2 mt-0.5 disabled:opacity-50"
      disabled={poolMutation.isPending}
      onClick={() => poolMutation.mutate({ roomIds: row.roomIds, on: !row.hourlyPool, label: row.label })}
      data-testid={`pool-toggle-${row.label}`}
    >
      {row.hourlyPool ? "Remove from priority" : "Add to priority"}
    </button>
  );

  const setFrom = (h: number) => setFromHour(h);

  const fmtHm = (iso: string) => {
    if (overview && iso === overview.dayEnd) return "24.00";
    return new Date(iso).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" }).replace(":", ".");
  };

  const causeLabel = (o: { cause: string; label?: string }) =>
    o.cause === "guest" ? "Guest"
      : o.cause === "hourly" ? "Hourly booking"
      : o.cause === "hourly-pending" ? "Hourly (pending payment)"
      : (o.label || "Blocked in MEWS");

  // Selected window in browser-local time (admin sits in property tz).
  // toHour ranges past 24: 26 = 02.00 the NEXT day.
  const dayMidnightMs = new Date(`${date}T00:00:00`).getTime();
  const winFromMs = new Date(`${date}T${String(fromHour).padStart(2, "0")}:00:00`).getTime();
  const winToMs = dayMidnightMs + toHour * 3600_000;
  const dayAEndMs = dayMidnightMs + 24 * 3600_000;

  type Classified = {
    row: DayAvailabilityDTO["rows"][number];
    status: RowStatus;
    cover?: { from: string; to: string };
    reason?: string;
  };

  const classified: Classified[] = useMemo(() => {
    if (!overview) return [];
    // Match rows across the two days by their twin-id set (same rule as the
    // server's cross-midnight slot stitching).
    const rowKey = (r: DayAvailabilityDTO["rows"][number]) => [...r.roomIds].sort().join("|");
    const nextByKey = new Map((nextOverview?.rows ?? []).map((r) => [rowKey(r), r]));
    // The part of the window inside day A; the rest (if crossing) is day B's.
    const endA = crossing ? dayAEndMs : winToMs;

    return overview.rows.map((row) => {
      const nextRow = crossing ? nextByKey.get(rowKey(row)) : undefined;
      const outOfService =
        row.state === "OutOfService" || row.state === "OutOfOrder" ||
        (crossing && (nextRow?.state === "OutOfService" || nextRow?.state === "OutOfOrder"));
      const cover = row.free.find(
        (f) => new Date(f.from).getTime() <= winFromMs && new Date(f.to).getTime() >= endA
      );
      const coverNext = !crossing || (nextRow?.free.some(
        (f) => new Date(f.from).getTime() <= dayAEndMs && new Date(f.to).getTime() >= winToMs
      ) ?? false);
      const overlapping = [
        ...row.occupied.filter(
          (o) => new Date(o.from).getTime() < endA && new Date(o.to).getTime() > winFromMs
        ),
        ...(crossing
          ? (nextRow?.occupied ?? []).filter(
              (o) => new Date(o.from).getTime() < winToMs && new Date(o.to).getTime() > dayAEndMs
            )
          : []),
      ];
      const blockHit = overlapping.find((o) => o.cause === "block");
      if (outOfService || blockHit) {
        return {
          row,
          status: "blocked" as RowStatus,
          reason: outOfService
            ? (row.state === "OutOfOrder" || nextRow?.state === "OutOfOrder" ? "Out of order (MEWS)" : "Out of service (MEWS)")
            : causeLabel(blockHit!),
        };
      }
      if (crossing && !nextOverview) {
        return { row, status: "partial" as RowStatus, reason: "Checking the next day…" };
      }
      if (cover && coverNext) return { row, status: "available" as RowStatus, cover };
      const freeOverlap = row.free.some(
        (f) => new Date(f.from).getTime() < endA && new Date(f.to).getTime() > winFromMs
      );
      const reason = overlapping.length
        ? overlapping.map((o) => `${fmtHm(o.from)}–${fmtHm(o.to)} ${causeLabel(o)}`).join(" · ")
        : undefined;
      return { row, status: (freeOverlap ? "partial" : "unavailable") as RowStatus, reason };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overview, nextOverview, crossing, winFromMs, winToMs, dayAEndMs]);

  // Hourly-booking priority (user decision 21/7): which capsule do we PREFER
  // to sell by the hour? Pool capsules first (they're designated for hourly),
  // then by readiness (Inspected → Clean → Dirty/unknown; Dirty is still
  // sellable — housekeeping gets an automatic SMS on booking), and capsules
  // free for the REST of the day before ones with an arrival/booking later
  // (less turnover pressure on housekeeping).
  const freeAllDay = (c: { cover?: { to: string } }) => !!(c.cover && overview && c.cover.to === overview.dayEnd);
  const scoreOf = (c: { row: { hourlyPool: boolean; state: string | null }; cover?: { to: string } }) =>
    priorityScore({ priority: c.row.hourlyPool, state: c.row.state, freeRestOfDay: freeAllDay(c) });
  const priorityLabel = (c: { row: { state: string | null }; cover?: { to: string } }) => {
    const ready = c.row.state === "Inspected" ? "Ready" : c.row.state === "Clean" ? "Clean" : "Needs cleaning";
    return `${ready} · ${freeAllDay(c) ? "free all day" : `free until ${c.cover ? fmtHm(c.cover.to) : "?"}`}`;
  };

  const available = classified
    .filter((c) => c.status === "available")
    .sort((a, b) =>
      scoreOf(a) - scoreOf(b) ||
      a.row.label.localeCompare(b.row.label, undefined, { numeric: true })
    );
  const others = classified.filter((c) => c.status !== "available");
  // Until-labels: 24 = midnight, above 24 = next-day hours (cross-midnight window).
  const toLabel = (h: number) => (h === 24 ? "24.00" : h > 24 ? `${hourLabel(h - 24)} (+1 day)` : hourLabel(h));
  const windowText = `${hourLabel(fromHour)} to ${toLabel(toHour)}`;

  const selectCls = "h-9 rounded-md border border-input bg-background px-3 text-sm";

  return (
    <Card className="mb-6">
      <CreateBookingDialog
        target={bookingTarget}
        onClose={() => setBookingTarget(null)}
        onBooked={() => {
          queryClient.invalidateQueries({ queryKey: ["hourly-availability"] });
          queryClient.invalidateQueries({ queryKey: ["hourly-bookings"] });
        }}
      />
      <CardContent className="pt-6">
        {/* Filter box */}
        <div className="rounded-lg border bg-muted/30 p-4 mb-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <select className={`${selectCls} min-w-48`} value={date} onChange={(e) => setDate(e.target.value)} data-testid="select-inv-date">
                {days.map((d) => <option key={d.iso} value={d.iso}>{d.label}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Start time</label>
              <select className={selectCls} value={fromHour} onChange={(e) => setFrom(Number(e.target.value))} data-testid="select-inv-from">
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-muted-foreground">Hours</label>
              <select className={selectCls} value={hours} onChange={(e) => setHours(Number(e.target.value))} data-testid="select-inv-hours">
                {Array.from({ length: MAX_BOOKING_HOURS }, (_, i) => i + 1).map((h) => (
                  <option key={h} value={h}>
                    {h} hour{h > 1 ? "s" : ""} (until {toLabel(fromHour + h)})
                  </option>
                ))}
              </select>
            </div>
            {isFetching && !isLoading && (
              <span className="text-xs text-muted-foreground pb-2.5">Updating…</span>
            )}
          </div>
        </div>

        {/* Warnings */}
        {overview && overview.unassignedCount > 0 && (
          <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {overview.unassignedCount} reservation{overview.unassignedCount === 1 ? "" : "s"} without an assigned capsule {overview.unassignedCount === 1 ? "is" : "are"} not shown per capsule — real availability may be lower.
          </div>
        )}
        {overview?.blocksUnknown && (
          <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            MEWS blocks could not be fetched — out-of-order periods may not be included.
          </div>
        )}
        {overview?.statesUnknown && (
          <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Housekeeping status could not be fetched from MEWS.
          </div>
        )}

        {/* States */}
        {isLoading && <p className="text-sm text-muted-foreground py-6 text-center">Loading inventory…</p>}
        {isError && (
          <p className="text-sm text-red-600 py-6 text-center" data-testid="inv-error">
            Inventory could not be loaded. Please try again.
          </p>
        )}

        {overview && !isError && (
          <>
            <p className="text-sm font-medium mb-1" data-testid="inv-count">
              {available.length} capsule{available.length === 1 ? "" : "s"} available from {windowText}
            </p>
            <p className="text-xs text-muted-foreground mb-3">
              Sorted by readiness first (Inspected → Clean → Dirty); priority-marked capsules win within each group, then all-day free before capsules occupied later.
              Dirty capsules can still be booked — housekeeping is texted automatically.
            </p>

            {available.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center" data-testid="inv-empty">
                No capsules are available for the selected date and time.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-2 pr-3 font-medium">#</th>
                      <th className="py-2 pr-4 font-medium">Capsule</th>
                      <th className="py-2 pr-4 font-medium">Type</th>
                      <th className="py-2 pr-4 font-medium">Priority</th>
                      <th className="py-2 pr-4 font-medium">Housekeeping</th>
                      <th className="py-2 pr-4 font-medium">Available from</th>
                      <th className="py-2 pr-4 font-medium">Available until</th>
                      <th className="py-2 pr-4 font-medium">Selected window</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {available.map((c, idx) => {
                      const { row, cover } = c;
                      return (
                        <tr key={row.roomId} className="border-b last:border-0" data-testid={`inv-row-${row.roomId}`}>
                          <td className="py-2.5 pr-3 text-muted-foreground">{idx + 1}</td>
                          <td className="py-2.5 pr-4">
                            <span className="text-base font-bold">{row.label}</span>
                            {row.hourlyPool && <Badge variant="secondary" className="ml-2">priority</Badge>}
                            {poolToggleButton(row)}
                          </td>
                          <td className="py-2.5 pr-4 whitespace-nowrap">{row.floor ? `${row.floor} Capsule` : "—"}</td>
                          <td className="py-2.5 pr-4 whitespace-nowrap text-muted-foreground">{priorityLabel(c)}</td>
                          <td className="py-2.5 pr-4"><HousekeepingBadge state={row.state} /></td>
                          <td className="py-2.5 pr-4 whitespace-nowrap">{cover ? fmtHm(cover.from) : "—"}</td>
                          <td className="py-2.5 pr-4 whitespace-nowrap">{cover ? fmtHm(cover.to) : "—"}</td>
                          <td className="py-2.5 pr-4 whitespace-nowrap text-green-700">
                            Available {hourLabel(fromHour)}–{toLabel(toHour)}
                          </td>
                          <td className="py-2.5 text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              data-testid={`create-booking-${row.label}`}
                              onClick={() =>
                                setBookingTarget({
                                  roomId: row.roomId,
                                  label: row.label,
                                  dateLabel: days.find((d) => d.iso === date)?.label || date,
                                  windowLabel: `${hourLabel(fromHour)}–${toLabel(toHour)}`,
                                  startIso: new Date(winFromMs).toISOString(),
                                  endIso: new Date(winToMs).toISOString(),
                                  hours: toHour - fromHour,
                                })
                              }
                            >
                              Create booking
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Secondary, collapsed: capsules that are not available in the window */}
            {others.length > 0 && (
              <div className="mt-4">
                <button
                  type="button"
                  className="text-sm text-muted-foreground underline underline-offset-2"
                  onClick={() => setShowOthers((v) => !v)}
                  data-testid="inv-toggle-others"
                >
                  {showOthers ? "Hide" : "Show"} {others.length} unavailable capsules
                </button>
                {showOthers && (
                  <div className="overflow-x-auto mt-2">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-muted-foreground border-b">
                          <th className="py-2 pr-4 font-medium">Capsule</th>
                          <th className="py-2 pr-4 font-medium">Type</th>
                          <th className="py-2 pr-4 font-medium">Status</th>
                          <th className="py-2 pr-4 font-medium">Housekeeping</th>
                          <th className="py-2 pr-4 font-medium">Reason in selected window</th>
                        </tr>
                      </thead>
                      <tbody>
                        {others.map(({ row, status, reason }) => (
                          <tr key={row.roomId} className="border-b last:border-0 text-muted-foreground">
                            <td className="py-2 pr-4">
                              <span className="font-semibold text-foreground">{row.label}</span>
                              {row.hourlyPool && <Badge variant="secondary" className="ml-2">priority</Badge>}
                              {poolToggleButton(row)}
                            </td>
                            <td className="py-2 pr-4 whitespace-nowrap">{row.floor ? `${row.floor} Capsule` : "—"}</td>
                            <td className="py-2 pr-4">
                              <Badge variant="outline" className={`${STATUS_BADGE[status].cls} border-transparent`}>
                                {STATUS_BADGE[status].label}
                              </Badge>
                            </td>
                            <td className="py-2 pr-4"><HousekeepingBadge state={row.state} /></td>
                            <td className="py-2 pr-4">{reason || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Upcoming time bookings (owner request 25/7): every booking from today
// onwards, below the inventory — plus the Cancel action that until now only
// existed as an unused API endpoint. ─────────────────────────────────────────

const BOOKING_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  confirmed: { label: "Confirmed", cls: "bg-green-100 text-green-800" },
  pending_payment: { label: "Pending payment", cls: "bg-amber-100 text-amber-800" },
  expired: { label: "Finished", cls: "bg-gray-200 text-gray-600" },
};

function HourlyBookingsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [cancelTarget, setCancelTarget] = useState<HourlyBookingDTO | null>(null);

  const { data: bookings, isLoading, isError, isFetching } = useQuery({
    queryKey: ["hourly-bookings"],
    queryFn: hourlyAPI.getBookings,
    refetchInterval: 30_000,
  });
  const { data: rooms } = useQuery({ queryKey: ["rooms-raw"], queryFn: hourlyAPI.getRawRooms });
  const roomLabel = useMemo(() => {
    const map = new Map((rooms ?? []).map((r) => [r.id, r.label || r.name]));
    return (id: string) => map.get(id) ?? "?";
  }, [rooms]);

  // Today 00:00 (browser-local = property tz for the admin) and onwards; a
  // booking stays listed until its END passes midnight — cross-midnight and
  // in-progress bookings remain visible. Cancelled rows are never reservations.
  const upcoming = useMemo(() => {
    const todayMidnight = new Date(`${isoLocalDate(new Date())}T00:00:00`).getTime();
    return (bookings ?? [])
      .filter((b) => b.status !== "cancelled" && new Date(b.endAt).getTime() >= todayMidnight)
      .sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
  }, [bookings]);

  const fmtDate = (iso: string) => {
    const s = new Date(iso).toLocaleDateString("da-DK", { weekday: "long", day: "numeric", month: "long" });
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  const fmtHm = (iso: string) => new Date(iso).toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" });
  const windowOf = (b: HourlyBookingDTO) => {
    const crossesMidnight = isoLocalDate(new Date(b.startAt)) !== isoLocalDate(new Date(b.endAt));
    return `${fmtHm(b.startAt)}–${fmtHm(b.endAt)}${crossesMidnight ? " (+1 day)" : ""}`;
  };

  const cancelMutation = useMutation({
    mutationFn: (id: string) => hourlyAPI.cancelBooking(id),
    onSuccess: (res) => {
      toast({
        title: "Booking cancelled",
        description: res.failed.length > 0
          ? `Code revoked from ${res.revoked} lock(s), but FAILED on: ${res.failed.join(", ")}`
          : `Door code revoked from ${res.revoked} lock(s).`,
        variant: res.failed.length > 0 ? "destructive" : undefined,
      });
      setCancelTarget(null);
      queryClient.invalidateQueries({ queryKey: ["hourly-bookings"] });
      queryClient.invalidateQueries({ queryKey: ["hourly-availability"] });
    },
    onError: (e: any) => toast({ title: "Cancel failed", description: e.message, variant: "destructive" }),
  });

  const badgeOf = (status: string) => {
    const b = BOOKING_STATUS_BADGE[status] ?? { label: status, cls: "bg-gray-100 text-gray-600" };
    return <Badge variant="outline" className={`${b.cls} border-transparent`}>{b.label}</Badge>;
  };

  return (
    <Card className="mb-6">
      <CardContent className="pt-6">
        <div className="flex items-center gap-3 mb-1">
          <p className="text-sm font-medium" data-testid="bookings-count">
            Time bookings — today and onwards ({upcoming.length})
          </p>
          {isFetching && !isLoading && <span className="text-xs text-muted-foreground">Updating…</span>}
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Every time booking from today onwards. Cancelling revokes the door code from all locks immediately.
        </p>

        {isLoading && <p className="text-sm text-muted-foreground py-6 text-center">Loading bookings…</p>}
        {isError && (
          <p className="text-sm text-red-600 py-6 text-center" data-testid="bookings-error">
            Bookings could not be loaded. Please try again.
          </p>
        )}
        {!isLoading && !isError && upcoming.length === 0 && (
          <p className="text-sm text-muted-foreground py-8 text-center" data-testid="bookings-empty">
            No time bookings today or in the future.
          </p>
        )}

        {upcoming.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Time</th>
                  <th className="py-2 pr-4 font-medium">Capsule</th>
                  <th className="py-2 pr-4 font-medium">Guest</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Amount</th>
                  <th className="py-2 pr-4 font-medium">Code</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {upcoming.map((b) => (
                  <tr key={b.id} className="border-b last:border-0" data-testid={`booking-row-${b.id}`}>
                    <td className="py-2.5 pr-4 whitespace-nowrap">{fmtDate(b.startAt)}</td>
                    <td className="py-2.5 pr-4 whitespace-nowrap">{windowOf(b)}</td>
                    <td className="py-2.5 pr-4"><span className="text-base font-bold">{roomLabel(b.roomId)}</span></td>
                    <td className="py-2.5 pr-4">
                      <div>{b.guestName}</div>
                      {(b.guestPhone || b.guestEmail) && (
                        <div className="text-xs text-muted-foreground">{b.guestPhone || b.guestEmail}</div>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      {badgeOf(b.status)}
                      {b.status === "confirmed" && !b.mewsReservationId && (
                        <div className="mt-1">
                          <Badge
                            variant="outline"
                            className="border-transparent bg-red-100 text-red-800"
                            title="Capsulen er ikke blokeret i MEWS — den kan sælges til en anden gæst samtidig"
                            data-testid={`no-mews-reservation-${b.id}`}
                          >
                            No MEWS block
                          </Badge>
                        </div>
                      )}
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap">{b.amount ? `${b.amount} ${b.currency ?? "DKK"}` : "—"}</td>
                    <td className="py-2.5 pr-4">
                      <span className="font-mono">{b.pinCode ?? "—"}</span>
                      <div className="text-xs text-muted-foreground">
                        {b.codeDeliveredAt ? `Sent ${fmtHm(b.codeDeliveredAt)}` : b.pinCode ? "Not sent" : ""}
                      </div>
                    </td>
                    <td className="py-2.5">
                      {(b.status === "confirmed" || b.status === "pending_payment") && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={cancelMutation.isPending}
                          onClick={() => setCancelTarget(b)}
                          data-testid={`cancel-booking-${b.id}`}
                        >
                          Cancel
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <AlertDialog open={!!cancelTarget} onOpenChange={(open) => { if (!open) setCancelTarget(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Cancel booking?</AlertDialogTitle>
              <AlertDialogDescription>
                {cancelTarget && (
                  <>
                    {cancelTarget.guestName} — Capsule {roomLabel(cancelTarget.roomId)}, {fmtDate(cancelTarget.startAt)} {windowOf(cancelTarget)}.{" "}
                    {cancelTarget.status === "pending_payment"
                      ? "No payment has been taken — the hold is simply released."
                      : "The door code is revoked from all locks immediately and the guest loses access."}
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep booking</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => cancelTarget && cancelMutation.mutate(cancelTarget.id)}
                data-testid="cancel-confirm"
              >
                Cancel booking
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

export default function HourlyRentalsPage() {
  return (
    <DashboardLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Clock className="w-6 h-6" /> Time Booking Inventory
        </h1>
        <p className="text-muted-foreground">Available capsules for time booking · today + next 6 days</p>
      </div>

      <TimeBookingInventoryCard />
      <HourlyBookingsCard />
    </DashboardLayout>
  );
}
