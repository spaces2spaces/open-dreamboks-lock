import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { arrivalsAPI } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RefreshCw, UserCheck } from "lucide-react";

// ── Arrivals — the live version of the hourly report email ──────────────────
// Polls every 30s; door-gap/offline data is the hourly audit snapshot from the
// server (the page itself never triggers TTLock traffic). UI is English
// (owner decision 23/7); the summary emails stay Danish.

// 10s (28/7, owner request): the page is now the PRIMARY surface — the
// routine list mail is retired, so the list must feel live.
const REFRESH_MS = 10_000;

function urlDate(): string | undefined {
  const d = new URLSearchParams(window.location.search).get("date") || undefined;
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined;
}

/** English long date from the server's yyyy-MM-dd (the email keeps its own Danish label). */
function englishDateLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}

function StatTile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className={`text-2xl font-bold ${tone ?? ""}`}>{value}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
      </CardContent>
    </Card>
  );
}

export default function ArrivalsPage() {
  const [date, setDate] = useState<string | undefined>(urlDate());
  // Share mode: opened via the mail's secret link (/arrivals/t/<token>) — no
  // login, no admin menu, and the page must never be indexed.
  const [isShare, shareParams] = useRoute("/arrivals/t/:token");
  const shareKey = isShare ? shareParams?.token : undefined;

  useEffect(() => {
    if (!isShare) return;
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, [isShare]);

  const { data, isLoading, error, dataUpdatedAt, refetch, isFetching } = useQuery({
    queryKey: ["arrivals", date ?? "auto", shareKey ?? "session"],
    queryFn: () => arrivalsAPI.get(date, shareKey),
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
  });

  const changeDate = (value: string) => {
    const next = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
    setDate(next);
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("date", next);
    else url.searchParams.delete("date");
    window.history.replaceState(null, "", url.toString());
  };

  const content = (
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <UserCheck className="w-6 h-6 text-primary" />
              Arrivals
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {data ? (
                <>Arrival date <span className="font-medium text-foreground">{englishDateLabel(data.reportDate)}</span> · updated {new Date(dataUpdatedAt).toLocaleTimeString("en-GB")} · auto-refreshes every {REFRESH_MS / 1000} s</>
              ) : (
                "Today's arrivals — live status"
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={date ?? (data?.reportDate || "")}
              onChange={(e) => changeDate(e.target.value)}
              className="w-40"
              data-testid="input-arrivals-date"
            />
            {date && (
              <Button variant="outline" size="sm" onClick={() => changeDate("")}>Today</Button>
            )}
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </div>

        {error && (
          <Card className="border-red-300 bg-red-50">
            <CardContent className="p-4 text-sm text-red-800">
              Could not load the arrivals list: {error instanceof Error ? error.message : "unknown error"}
            </CardContent>
          </Card>
        )}

        {isLoading && <div className="text-muted-foreground">Loading arrivals…</div>}

        {data && (
          <>
            {data.urgentReasons.length > 0 && (
              <div className="rounded-lg bg-red-900 text-white p-4 space-y-1">
                {data.urgentReasons.map((r, i) => (
                  <p key={i} className="font-semibold text-sm">🚨 {r}</p>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <StatTile label="Arrivals" value={data.counts.total} />
              <StatTile label="Via code" value={data.counts.viaCode} tone="text-green-600" />
              <StatTile label="Manual" value={data.counts.manual} tone="text-green-600" />
              <StatTile label="Not arrived" value={data.counts.notArrived} tone="text-gray-500" />
              <StatTile label="MEWS rejected" value={data.counts.mewsRejected} tone={data.counts.mewsRejected ? "text-red-600" : "text-gray-400"} />
              <StatTile label="Awaiting payment" value={data.counts.awaitingPayment} tone={data.counts.awaitingPayment ? "text-amber-600" : "text-gray-400"} />
              <StatTile label="🧹 Extra cleaning" value={data.counts.cleaning ?? 0} tone={data.counts.cleaning ? "text-orange-600" : "text-gray-400"} />
            </div>

            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                      <th className="px-4 py-3">Name</th>
                      <th className="px-4 py-3">Capsule</th>
                      <th className="px-4 py-3">Housekeeping</th>
                      <th className="px-4 py-3">Code</th>
                      <th className="px-4 py-3">Purchases</th>
                      <th className="px-4 py-3">Message sent</th>
                      <th className="px-4 py-3">Checked in</th>
                      <th className="px-4 py-3">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                          No arrivals on this date.
                        </td>
                      </tr>
                    )}
                    {data.rows.map((row) => (
                      <tr key={row.reservationId} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="px-4 py-2.5 font-medium">
                          {row.mewsUrl ? (
                            <a href={row.mewsUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">
                              {row.guestName}
                            </a>
                          ) : row.guestName}
                        </td>
                        <td className="px-4 py-2.5 font-semibold">{row.room}</td>
                        <td className="px-4 py-2.5">
                          <Badge variant="outline" className="border-transparent" style={{ backgroundColor: `${row.hk.color}18`, color: row.hk.color }}>
                            {row.hk.label}
                          </Badge>
                        </td>
                        <td className="px-4 py-2.5 font-mono tracking-widest">{row.code ?? "—"}</td>
                        <td className="px-4 py-2.5">
                          {!row.earlyCheckinFrom && !row.lateCheckoutUntil && <span className="text-muted-foreground">—</span>}
                          <div className="flex flex-col gap-1">
                            {row.earlyCheckinFrom && (
                              <Badge variant="outline" className="border-transparent bg-purple-100 text-purple-800 whitespace-nowrap">
                                Early from {row.earlyCheckinFrom}
                              </Badge>
                            )}
                            {row.lateCheckoutUntil && (
                              <Badge variant="outline" className="border-transparent bg-indigo-100 text-indigo-800 whitespace-nowrap">
                                Late until {row.lateCheckoutUntil}
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-2.5">
                          {row.msgSent
                            ? <span className="text-green-600">Yes</span>
                            : <span className="text-red-600 font-semibold">No</span>}
                        </td>
                        <td className="px-4 py-2.5 font-semibold" style={{ color: row.status.color }}>{row.status.text}</td>
                        <td className="px-4 py-2.5 text-xs text-red-700">{row.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {data.doorGaps.length > 0 && (
              <Card className="border-red-200 bg-red-50">
                <CardContent className="p-4 space-y-1">
                  <p className="font-semibold text-red-800 text-sm">
                    ⚠️ Codes missing on doors (verified against the lock{data.auditAt ? ` at ${new Date(data.auditAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : ""})
                  </p>
                  {data.doorGaps.map((g, i) => (
                    <p key={i} className="text-sm text-red-900">
                      <span className="font-semibold">{g.lockName}</span>: {g.guestName} ({g.code}{g.reason === "stale-entry" ? ", stale entry" : ""})
                    </p>
                  ))}
                  <p className="text-xs text-red-700 pt-1">
                    The system re-pushes automatically every {data.repairIntervalMinutes} minutes.
                  </p>
                </CardContent>
              </Card>
            )}

            {data.offlineDoors.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Offline doors — codes are pushed automatically once the gateway is back online: <span className="font-semibold">{data.offlineDoors.join(", ")}</span>
              </p>
            )}

            {data.upsells.lines.length > 0 && (
              <Card className="border-green-200 bg-green-50">
                <CardContent className="p-4 space-y-1">
                  <p className="font-semibold text-green-900 text-sm">
                    💰 Purchases today ({data.upsells.lines.length}){data.upsells.totals ? ` — total ${data.upsells.totals}` : ""}
                  </p>
                  {data.upsells.lines.map((u, i) => (
                    <p key={i} className="text-sm text-green-900">
                      <span className="font-semibold">{u.kind}</span>: {u.guestName} at {u.time} — {u.amount}
                    </p>
                  ))}
                </CardContent>
              </Card>
            )}

            {data.blocks.length > 0 && (
              <Card className="border-amber-200 bg-amber-50">
                <CardContent className="p-4 space-y-1">
                  <p className="font-semibold text-amber-900 text-sm">🔧 Blocked capsules (from MEWS)</p>
                  {data.blocks.map((b, i) => (
                    <p key={i} className="text-sm text-amber-900">
                      <span className="font-semibold">{b.roomLabel}</span>: {b.typeLabel} {b.start} – {b.end}{b.name ? ` (${b.name})` : ""}
                    </p>
                  ))}
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
  );

  // Mail-link mode: bare page, no admin chrome — readable on a phone.
  if (isShare) {
    return (
      <div className="min-h-screen bg-background text-foreground">
        <div className="max-w-5xl mx-auto p-4 sm:p-6 md:p-8">{content}</div>
      </div>
    );
  }

  return <DashboardLayout>{content}</DashboardLayout>;
}
