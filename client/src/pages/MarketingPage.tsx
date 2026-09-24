import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import {
  marketingAPI,
  settingsAPI,
  type MarketingCampaignDTO,
  type MarketingHistoryDay,
  type MarketingSendResult,
} from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Megaphone } from "lucide-react";
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

// ── Marketing — upsell SMS campaigns (owner feature 27/7) ────────────────────
// Each campaign card: scheduler toggle + send time + SMS text override, live
// audience preview, dry run, test SMS to any number, and the real Send now
// behind a confirmation. All config is plain settings; sends are logged in
// marketing_sends (per-stay dedupe — a guest never gets a campaign twice).

function CampaignCard({ c }: { c: MarketingCampaignDTO }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showAudience, setShowAudience] = useState(false);
  const [dryRun, setDryRun] = useState<MarketingSendResult | null>(null);
  const [testTo, setTestTo] = useState("");
  const [confirmSend, setConfirmSend] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["marketing-campaigns"] });
    queryClient.invalidateQueries({ queryKey: ["marketing-history"] });
  };

  const saveSetting = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) => settingsAPI.update(key, value),
    onSuccess: invalidate,
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const sendMutation = useMutation({
    mutationFn: (opts: { dryRun?: boolean; testTo?: string }) => marketingAPI.send(c.id, opts),
    onSuccess: (result, vars) => {
      if (vars.dryRun) { setDryRun(result); return; }
      if (vars.testTo) {
        toast({
          title: result.ok ? "Test SMS sent" : "Test SMS failed",
          description: result.ok ? `Sent to ${result.to}` : result.error,
          variant: result.ok ? undefined : "destructive",
        });
        return;
      }
      setConfirmSend(false);
      toast({
        title: result.ok ? "Campaign sent" : "Campaign failed",
        description: result.ok
          ? `${result.sent?.length ?? 0} sent · ${result.failed?.length ?? 0} failed · ${result.skipped?.length ?? 0} skipped`
          : result.error,
        variant: result.ok && (result.failed?.length ?? 0) === 0 ? undefined : "destructive",
      });
      invalidate();
    },
    onError: (e: any) => toast({ title: "Request failed", description: e.message, variant: "destructive" }),
  });

  return (
    <Card className="mb-6">
      <CardContent className="pt-6 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-base font-semibold">{c.label}</p>
          <Badge variant="outline" className={`${c.enabled ? "bg-green-100 text-green-800" : "bg-gray-200 text-gray-600"} border-transparent`}>
            {c.enabled ? `Scheduled daily ${c.sendTime}` : "Scheduler off"}
          </Badge>
          {c.lastSentDate && <span className="text-xs text-muted-foreground">Last auto-send: {c.lastSentDate}</span>}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Send automatically</span>
            <Switch
              checked={c.enabled}
              onCheckedChange={(on) => saveSetting.mutate({ key: `marketing_${c.id}_enabled`, value: on ? "true" : "false" })}
              data-testid={`toggle-${c.id}`}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Daily send time (hotel time)</label>
            <Input
              type="time"
              className="mt-1 w-36"
              defaultValue={c.sendTime}
              onBlur={(e) => {
                if (e.target.value && e.target.value !== c.sendTime) {
                  saveSetting.mutate({ key: `marketing_${c.id}_send_time`, value: e.target.value });
                }
              }}
              data-testid={`time-${c.id}`}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              SMS text (placeholders: {"{name} {hotel} {link}"} — empty = default; {"{link}"} includes the guest's door code so the page opens pre-filled)
            </label>
            <textarea
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-20"
              defaultValue={c.smsText ?? ""}
              placeholder={c.defaultSmsText}
              onBlur={(e) => {
                if (e.target.value.trim() !== (c.smsText ?? "").trim()) {
                  saveSetting.mutate({ key: `marketing_${c.id}_sms_text`, value: e.target.value.trim() });
                }
              }}
              data-testid={`text-${c.id}`}
            />
          </div>
        </div>

        <div className="rounded-md bg-muted/40 p-3 text-sm">
          <span className="text-xs font-medium text-muted-foreground block mb-1">Message preview</span>
          {c.preview}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="text-sm underline text-muted-foreground"
            onClick={() => setShowAudience(v => !v)}
            data-testid={`audience-toggle-${c.id}`}
          >
            Audience right now: <b>{c.audienceCount}</b> guest{c.audienceCount === 1 ? "" : "s"} {showAudience ? "▲" : "▼"}
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={sendMutation.isPending}
              onClick={() => sendMutation.mutate({ dryRun: true })} data-testid={`dryrun-${c.id}`}>
              Preview (dry run)
            </Button>
            <Input
              className="w-40 h-9"
              placeholder="+45… test number"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              data-testid={`testto-${c.id}`}
            />
            <Button size="sm" variant="outline" disabled={sendMutation.isPending || !testTo.trim()}
              onClick={() => sendMutation.mutate({ testTo: testTo.trim() })} data-testid={`testsend-${c.id}`}>
              Send test SMS
            </Button>
            <Button size="sm" disabled={sendMutation.isPending || c.audienceCount === 0}
              onClick={() => setConfirmSend(true)} data-testid={`sendnow-${c.id}`}>
              Send now
            </Button>
          </div>
        </div>

        {showAudience && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="py-2 pr-4 font-medium">Guest</th>
                  <th className="py-2 pr-4 font-medium">Capsule</th>
                  <th className="py-2 pr-4 font-medium">Mobile</th>
                </tr>
              </thead>
              <tbody>
                {c.audience.map(a => (
                  <tr key={a.reservationId} className="border-b last:border-0">
                    <td className="py-2 pr-4">{a.name}</td>
                    <td className="py-2 pr-4">{a.capsule}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{a.mobile}</td>
                  </tr>
                ))}
                {c.audience.length === 0 && (
                  <tr><td colSpan={3} className="py-3 text-muted-foreground">Nobody matches the campaign criteria right now.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {dryRun && (
          <div className="rounded-md border p-3 space-y-2" data-testid={`dryrun-result-${c.id}`}>
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Dry run — {dryRun.recipients?.length ?? 0} would receive:</p>
              <Button size="sm" variant="ghost" onClick={() => setDryRun(null)}>Close</Button>
            </div>
            {(dryRun.recipients ?? []).map(r => (
              <div key={r.reservationId} className="text-xs border-b last:border-0 pb-2">
                <span className="font-medium">{r.name}</span> <span className="font-mono">{r.mobile}</span>
                <div className="text-muted-foreground mt-0.5">{r.body}</div>
              </div>
            ))}
          </div>
        )}

        <AlertDialog open={confirmSend} onOpenChange={(open) => { if (!open) setConfirmSend(false); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Send "{c.label}" now?</AlertDialogTitle>
              <AlertDialogDescription>
                A real SMS goes to {c.audienceCount} guest{c.audienceCount === 1 ? "" : "s"} right now. Each guest can
                only ever receive this campaign once per stay.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => sendMutation.mutate({})} data-testid={`sendnow-confirm-${c.id}`}>
                Send to {c.audienceCount}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// ── History chart — sends and purchases day by day ───────────────────────────
// Replaces the old per-SMS send log (owner request 4/8): one evolving curve
// per campaign (sends) plus the purchases they produced. Sends (up to ~40/day)
// and purchases (0–3/day) live in SEPARATE panels sharing the time axis —
// on one axis the purchases were invisible, and a dual y-axis is worse.
// Hue = campaign (EC blue, LC orange) in both panels.
const SERIES = [
  { key: "ecSent", label: "Early check-in — SMS sendt", color: "#2a78d6" },
  { key: "lcSent", label: "Late check-out — SMS sendt", color: "#eb6834" },
  { key: "ecPurchases", label: "Early check-in — købt", color: "#2a78d6" },
  { key: "lcPurchases", label: "Late check-out — købt", color: "#eb6834" },
] as const;
// Identical margins + fixed y-axis width on both panels so the day columns
// line up exactly between the line chart and the bar chart below it.
const PANEL_MARGIN = { top: 8, right: 12, bottom: 0, left: 0 };
const Y_AXIS_WIDTH = 34;

const RANGES = [14, 30, 90] as const;

function fmtDay(day: string) {
  const [, m, d] = day.split("-");
  return `${parseInt(d, 10)}/${parseInt(m, 10)}`;
}

function HistoryTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const row: MarketingHistoryDay | undefined = payload[0]?.payload;
  return (
    <div className="rounded-md border bg-background p-3 text-xs shadow-md">
      <p className="font-medium mb-1">
        {new Date(`${label}T12:00:00`).toLocaleDateString("da-DK", { weekday: "long", day: "numeric", month: "long" })}
      </p>
      {SERIES.map(s => (
        <p key={s.key} className="flex items-center gap-2">
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />
          {s.label}: <b>{row?.[s.key] ?? 0}</b>
        </p>
      ))}
      {row && row.failed > 0 && <p className="text-red-600 mt-1">{row.failed} fejlede sends</p>}
      {row && row.revenue > 0 && (
        <p className="text-muted-foreground mt-1">Omsætning (EC+LC): {row.revenue.toLocaleString("da-DK")} kr.</p>
      )}
    </div>
  );
}

function HistoryChart() {
  const [days, setDays] = useState<number>(30);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["marketing-history", days],
    queryFn: () => marketingAPI.history(days),
    refetchInterval: 60_000,
  });
  const rows = data?.days ?? [];
  const totals = rows.reduce(
    (acc, r) => ({ sent: acc.sent + r.ecSent + r.lcSent, bought: acc.bought + r.ecPurchases + r.lcPurchases, revenue: acc.revenue + r.revenue }),
    { sent: 0, bought: 0, revenue: 0 },
  );

  return (
    <Card className="mb-6">
      <CardContent className="pt-6">
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <p className="text-sm font-medium">Historik — udsendelser og køb pr. dag</p>
          <span className="text-xs text-muted-foreground">
            {totals.sent} sendt · {totals.bought} køb · {totals.revenue.toLocaleString("da-DK")} kr. i perioden
          </span>
          <div className="ml-auto flex gap-1">
            {RANGES.map(r => (
              <Button
                key={r}
                size="sm"
                variant={days === r ? "default" : "outline"}
                onClick={() => setDays(r)}
                data-testid={`history-range-${r}`}
              >
                {r} dage
              </Button>
            ))}
          </div>
        </div>
        {isLoading && <p className="text-sm text-muted-foreground py-10 text-center">Henter historik…</p>}
        {isError && <p className="text-sm text-red-600 py-10 text-center">Historikken kunne ikke hentes.</p>}
        {!isLoading && !isError && (
          <div data-testid="marketing-history-chart">
            <p className="text-xs font-medium text-muted-foreground mb-1">SMS sendt pr. dag</p>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows} margin={PANEL_MARGIN} syncId="marketing-history">
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.12} vertical={false} />
                  <XAxis dataKey="day" tick={false} tickLine={false} axisLine={false} height={4} />
                  <YAxis allowDecimals={false} width={Y_AXIS_WIDTH} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                  <ChartTooltip content={<HistoryTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
                  <Line type="monotone" dataKey="ecSent" name="Early check-in — SMS sendt" stroke="#2a78d6" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
                  <Line type="monotone" dataKey="lcSent" name="Late check-out — SMS sendt" stroke="#eb6834" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs font-medium text-muted-foreground mb-1 mt-2">Køb pr. dag (egen skala)</p>
            <div className="h-36">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} margin={PANEL_MARGIN} syncId="marketing-history" barCategoryGap="30%" barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.12} vertical={false} />
                  <XAxis
                    dataKey="day"
                    tickFormatter={fmtDay}
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                    minTickGap={24}
                    tickLine={false}
                  />
                  <YAxis allowDecimals={false} width={Y_AXIS_WIDTH} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                  <ChartTooltip content={<HistoryTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="ecPurchases" name="Early check-in — købt" fill="#2a78d6" radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} />
                  <Bar dataKey="lcPurchases" name="Late check-out — købt" fill="#eb6834" radius={[3, 3, 0, 0]} maxBarSize={14} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground mt-2">
          Kurven vokser dag for dag — udsendelser gemmes varigt, også efter gæsterne er tjekket ud. Køb vises i eget panel med egen skala, så de ikke drukner i antallet af sends.
        </p>
      </CardContent>
    </Card>
  );
}

export default function MarketingPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["marketing-campaigns"],
    queryFn: marketingAPI.campaigns,
    refetchInterval: 60_000,
  });

  return (
    <DashboardLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Megaphone className="w-6 h-6" /> Marketing
        </h1>
        <p className="text-muted-foreground">Upsell SMS campaigns — each guest gets a campaign at most once per stay</p>
      </div>

      <HistoryChart />

      {isLoading && <p className="text-sm text-muted-foreground py-6 text-center">Loading campaigns…</p>}
      {isError && <p className="text-sm text-red-600 py-6 text-center">Campaigns could not be loaded.</p>}
      {(data?.campaigns ?? []).map(c => <CampaignCard key={c.id} c={c} />)}
    </DashboardLayout>
  );
}
