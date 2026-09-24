import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useParams, useRoute } from "wouter";
import { QRCodeSVG } from "qrcode.react";
import { type GuestTheme, guestThemeStyle, useGuestFont, useFavicon } from "@/lib/guest-theme";

// Guest info screen — a wall-mounted kiosk tablet in the common area
// (/:hotel/info). Shows per-tenant content from guest_info_* settings plus a
// "Find my door code" lookup for guests who never received the SMS/email.
// Shared screen: no unlock buttons, no QR, results auto-dismiss.

interface GuestInfoData {
  name: string;
  slug: string;
  theme: GuestTheme | null;
  checkInTime: string;
  checkOutTime: string;
  address: string | null;
  wifi: { network: string; password: string | null } | null;
  hasFlights: boolean;
  earlyCheckin: { pricePerHour: number; eurRate: number; tiers: Array<{ label: string; dkk: number }> } | null;
  lateCheckout: { pricePerHour: number; eurRate: number } | null;
  parkingPaymentUrl: string | null;
  contactPhone: string | null;
  sections: {
    checkin: string | null;
    parking: string | null;
    facilities: string | null;
    rules: string | null;
    gettingAround: string | null;
    contact: string | null;
    explore: string | null;
  };
}

interface Flight {
  flightNumber: string;
  airline: string;
  city: string;
  scheduledTime: string;
  expectedTime: string;
  gate: string | null;
  status: string;
  delayed: boolean;
}

interface FlightsData {
  departures: Flight[];
  arrivals: Flight[];
  lastUpdated: string | null;
}

interface DoorCodeEntry {
  capsule: string | null;
  pin: { code: string; validFrom: string | null; validTo: string | null } | null;
  reason: "already_checked_in" | "payment" | "not_checked_in" | "not_ready" | null;
}

interface DoorCodeResponse {
  found?: boolean;
  multiple?: boolean;
  count?: number;
  firstName?: string;
  results?: DoorCodeEntry[];
  error?: string;
}

// ---- Scoped stylesheet (ported from the boarding card's dlk- design, scaled
// up for a wall tablet: bigger type, wider card, >=64px hit targets). Brand
// fallbacks are Capsule green — the kiosk's first tenant — but any tenant's
// boarding_* branding overrides them via guestThemeStyle CSS vars. ----------
const KIOSK_CSS = `
.gik-root{--bg:#eef1f6;--surface:#fff;--ink:#1a1d23;--muted:#6b7280;--faint:#9aa1ad;--line:#e7e9ef;--line-strong:#d7dae2;--green:#16a34a;--green-tint:#e6f6ec;
  font-family:var(--guest-font,"Plus Jakarta Sans",system-ui,-apple-system,sans-serif);min-height:100vh;background:var(--bg);color:var(--ink);
  display:flex;justify-content:center;align-items:flex-start;padding:28px 20px 60px;user-select:none;-webkit-user-select:none;}
.gik-root *{box-sizing:border-box;}
.gik-app{width:100%;max-width:900px;}
.gik-card{background:var(--surface);border-radius:28px;overflow:hidden;box-shadow:0 26px 60px -28px rgba(20,24,40,.4),0 1px 0 rgba(255,255,255,.6);}
.gik-head{position:relative;background:linear-gradient(135deg,var(--brand,#509E2F),var(--brand-dark,#448728));color:#fff;padding:26px 30px 28px;}
.gik-head::after{content:"";position:absolute;inset:0;background:radial-gradient(80% 120% at 90% -20%,rgba(255,255,255,.22),transparent 55%);}
.gik-head .row{position:relative;display:flex;align-items:center;justify-content:space-between;gap:14px;}
.gik-logo{display:flex;align-items:center;gap:14px;min-width:0;}
.gik-logo img{height:56px;width:auto;display:block;}
.gik-logo h1{font-weight:800;font-size:26px;letter-spacing:-.3px;line-height:1.05;}
.gik-logo p{font-size:15px;color:rgba(255,255,255,.9);margin-top:4px;}
.gik-mark{width:52px;height:52px;flex-shrink:0;border-radius:14px;display:grid;place-items:center;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.28);}
.gik-mark svg{width:26px;height:26px;}
.gik-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:22px;}
@media (max-width:640px){.gik-grid{grid-template-columns:1fr;}}
.gik-tile{-webkit-appearance:none;appearance:none;font:inherit;text-align:left;display:flex;align-items:center;gap:16px;cursor:pointer;color:var(--ink);background:var(--surface);border:2px solid var(--line-strong);border-radius:18px;padding:20px;min-height:104px;box-shadow:0 4px 0 var(--line-strong);transition:transform .12s ease,box-shadow .12s ease,border-color .25s;}
.gik-tile:hover{border-color:var(--brand,#509E2F);}
.gik-tile:active{transform:translateY(4px);box-shadow:0 0 0 var(--line-strong);}
.gik-tile .ico{width:58px;height:58px;flex-shrink:0;border-radius:15px;display:grid;place-items:center;background:var(--brand-tint,rgba(80,158,47,.12));}
.gik-tile .ico svg{width:29px;height:29px;stroke:var(--brand,#509E2F);}
.gik-tile .meta{flex:1;min-width:0;}
.gik-tile .meta .t{font-weight:800;font-size:19px;line-height:1.15;}
.gik-tile .meta .s{font-size:14px;color:var(--muted);margin-top:4px;}
.gik-tile.hero{grid-column:1 / -1;border-color:var(--brand,#509E2F);background:linear-gradient(135deg,var(--brand,#509E2F),var(--brand-dark,#448728));color:#fff;box-shadow:0 4px 0 var(--brand-dark,#448728);}
.gik-tile.hero .ico{background:rgba(255,255,255,.18);}
.gik-tile.hero .ico svg{stroke:#fff;}
.gik-tile.hero .meta .s{color:rgba(255,255,255,.85);}
.gik-tile.hero:active{box-shadow:0 0 0 var(--brand-dark,#448728);}
.gik-foot{text-align:center;font-size:12px;color:var(--faint);padding:14px 0 4px;font-weight:600;letter-spacing:.3px;}
.gik-panel{position:fixed;inset:0;z-index:40;background:var(--bg);display:flex;justify-content:center;align-items:flex-start;padding:28px 20px 60px;overflow-y:auto;}
.gik-panel .inner{width:100%;max-width:900px;}
.gik-back{-webkit-appearance:none;appearance:none;font:inherit;display:inline-flex;align-items:center;gap:10px;cursor:pointer;color:var(--ink);background:var(--surface);border:2px solid var(--line-strong);border-radius:16px;padding:16px 24px;font-weight:800;font-size:18px;box-shadow:0 4px 0 var(--line-strong);margin-bottom:18px;transition:transform .12s ease,box-shadow .12s ease;}
.gik-back:active{transform:translateY(4px);box-shadow:0 0 0 var(--line-strong);}
.gik-back svg{width:20px;height:20px;}
.gik-body{padding:28px 30px 32px;}
.gik-body h2{font-size:24px;font-weight:800;display:flex;align-items:center;gap:12px;}
.gik-body h2 svg{width:26px;height:26px;stroke:var(--brand,#509E2F);flex-shrink:0;}
.gik-body p{font-size:17px;line-height:1.6;color:var(--ink);margin-top:14px;}
.gik-body h3{font-size:20px;font-weight:800;margin-top:26px;}
.gik-body ul{margin-top:14px;padding-left:24px;display:flex;flex-direction:column;gap:8px;list-style:disc;}
.gik-body li{font-size:17px;line-height:1.5;}
.gik-bigrow{display:flex;flex-wrap:wrap;gap:16px;margin-top:18px;}
.gik-bigbox{flex:1;min-width:220px;background:var(--bg);border:1px solid var(--line);border-radius:18px;padding:18px 20px;}
.gik-bigbox .k{font-size:12px;text-transform:uppercase;letter-spacing:1.2px;color:var(--faint);font-weight:800;}
.gik-bigbox .v{font-family:"DM Mono",ui-monospace,monospace;font-size:30px;font-weight:800;margin-top:8px;word-break:break-all;}
.gik-bigbox .v.plain{font-family:inherit;font-size:24px;}
.gik-qrwrap{margin-top:20px;text-align:center;}
.gik-qr{display:inline-block;background:#fff;border:1px solid var(--line);border-radius:20px;padding:20px;line-height:0;}
.gik-qrhint{font-size:15px;color:var(--muted);margin-top:12px;font-weight:600;}
.gik-lookup{margin-top:18px;display:flex;flex-direction:column;gap:16px;max-width:520px;}
/* Direct-payment button: hidden on the wall tablet (guests pay on their own
   phone via QR there) but shown on phones, where scanning your own screen is
   impossible — the MEWS payment page is a normal card form. */
.gik-payopen{display:none;}
@media (max-width:820px){.gik-payopen{display:flex;}}
.gik-lookup label{font-size:14px;font-weight:700;color:var(--muted);display:block;margin-bottom:8px;}
.gik-lookup input{width:100%;background:var(--bg);border:1.5px solid var(--line-strong);border-radius:14px;color:var(--ink);font:inherit;font-size:20px;padding:16px;outline:none;transition:border-color .2s;user-select:text;-webkit-user-select:text;}
.gik-lookup input:focus{border-color:var(--brand,#509E2F);}
.gik-lookup button{width:100%;border:none;border-radius:15px;background:var(--brand,#509E2F);color:#fff;font:inherit;font-weight:800;font-size:19px;padding:18px;cursor:pointer;margin-top:4px;}
.gik-lookup button:disabled{opacity:.6;cursor:default;}
.gik-err{margin-top:16px;font-size:16px;font-weight:600;color:#dc2626;background:rgba(229,62,62,.08);border:1px solid rgba(229,62,62,.4);border-radius:14px;padding:14px 18px;max-width:520px;}
.gik-result{text-align:center;padding:8px 0;}
.gik-result .hi{font-size:20px;color:var(--muted);font-weight:600;}
.gik-result .easy{margin-top:6px;font-size:22px;font-weight:800;color:var(--brand,#3f7d2c);}
.gik-result .capsule{font-size:34px;font-weight:800;margin-top:10px;}
.gik-digits{display:flex;justify-content:center;gap:12px;margin:22px 0 10px;flex-wrap:wrap;}
.gik-digits .d{font-family:"DM Mono",ui-monospace,monospace;font-size:44px;color:var(--ink);width:66px;height:82px;display:grid;place-items:center;border-radius:14px;background:var(--surface);border:2px solid var(--line-strong);}
.gik-digits .d.hash{color:var(--brand,#509E2F);border-color:var(--brand,#509E2F);background:var(--brand-tint,rgba(80,158,47,.12));}
.gik-keyhint{font-size:15px;color:var(--muted);font-weight:600;margin-bottom:8px;}
.gik-valid{font-size:15px;color:var(--faint);}
.gik-valid b{color:var(--muted);font-weight:600;}
.gik-usednote{margin:26px auto 0;max-width:520px;font-size:15px;color:var(--muted);font-weight:600;line-height:1.5;}
.gik-countdown{margin-top:16px;font-size:13px;color:var(--faint);font-weight:600;}
.gik-codeblock{margin-top:26px;padding-top:22px;border-top:1px solid var(--line);}
.gik-opthead{display:flex;align-items:center;gap:12px;margin-top:24px;}
.gik-opthead .num{width:36px;height:36px;flex-shrink:0;border-radius:50%;display:grid;place-items:center;background:var(--brand,#509E2F);color:#fff;font-weight:800;font-size:18px;}
.gik-opthead .ttl{font-size:20px;font-weight:800;}
.gik-howto{display:flex;gap:26px;align-items:flex-start;flex-wrap:wrap;}
.gik-howto .txt{flex:1;min-width:280px;}
.gik-video{width:225px;flex-shrink:0;margin-top:14px;border-radius:18px;border:1px solid var(--line);background:#000;overflow:hidden;line-height:0;}
.gik-video video{display:block;width:100%;height:auto;}
@media (max-width:640px){.gik-video{margin:14px auto 0;}}
.gik-flhead{display:flex;justify-content:space-between;align-items:center;gap:18px;flex-wrap:wrap;margin-top:18px;}
.gik-secwait{border:1px solid var(--line);border-radius:16px;background:#fff;}
.gik-fltoggle{display:flex;gap:8px;background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:5px;width:fit-content;}
.gik-fltoggle button{-webkit-appearance:none;appearance:none;font:inherit;border:none;cursor:pointer;border-radius:999px;padding:12px 26px;font-weight:800;font-size:16px;background:transparent;color:var(--muted);}
.gik-fltoggle button.on{background:var(--brand,#509E2F);color:#fff;}
.gik-flboard{margin-top:18px;border:1px solid var(--line);border-radius:16px;overflow:hidden;}
.gik-flrow{display:grid;grid-template-columns:120px 96px 1fr 70px 130px;gap:10px;align-items:center;padding:13px 18px;border-top:1px solid var(--line);font-size:16px;}
.gik-flrow:first-child{border-top:none;}
.gik-flrow.head{background:var(--bg);font-size:11px;text-transform:uppercase;letter-spacing:1.1px;color:var(--faint);font-weight:800;}
.gik-flrow .tm b{font-family:"DM Mono",ui-monospace,monospace;font-weight:500;}
.gik-flrow .tm s{color:var(--faint);margin-right:6px;font-family:"DM Mono",ui-monospace,monospace;}
.gik-flrow .tm b.late{color:#d97706;}
.gik-flrow .fn{font-family:"DM Mono",ui-monospace,monospace;}
.gik-flrow .ci{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gik-flrow .gt{color:var(--muted);}
.gik-flrow .st{font-size:14px;color:var(--muted);text-align:right;}
.gik-flrow .st.late{color:#d97706;font-weight:700;}
.gik-flfoot{font-size:13px;color:var(--faint);margin-top:12px;text-align:center;}
@media (max-width:640px){.gik-flrow{grid-template-columns:96px 80px 1fr 90px;}.gik-flrow .gt{display:none;}}
.gik-notice{margin-top:18px;border-radius:16px;padding:22px;text-align:center;background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.4);}
.gik-notice .ttl{font-weight:800;font-size:19px;color:#b45309;}
.gik-notice .sub{font-size:16px;color:var(--muted);margin-top:8px;line-height:1.5;}
.gik-ec-cta{display:block;width:100%;margin-top:18px;border:none;border-radius:15px;background:var(--brand,#509E2F);color:#fff;font:inherit;font-weight:800;font-size:18px;padding:18px 22px;cursor:pointer;text-align:center;line-height:1.4;}
.gik-ec-cta .sub{display:block;font-weight:600;font-size:15px;opacity:.9;margin-top:4px;}
.gik-linkbtn{display:block;margin:18px auto 0;border:none;background:none;font:inherit;font-size:16px;font-weight:700;color:var(--brand,#509E2F);text-decoration:underline;text-underline-offset:3px;cursor:pointer;}
.gik-auto{margin-top:18px;border-radius:16px;padding:20px 22px;background:var(--brand-tint,rgba(80,158,47,.10));border:1px solid var(--brand,#509E2F);max-width:560px;}
.gik-auto .ttl{font-weight:800;font-size:18px;color:var(--ink);margin-bottom:6px;}
.gik-auto p{font-size:16px;color:var(--muted);line-height:1.5;margin:0;}
.gik-auto ul{margin:8px 0 0;padding-left:22px;}
.gik-auto li{font-size:16px;color:var(--muted);line-height:1.55;margin:6px 0;}
.gik-auto li b{color:var(--ink);font-weight:700;}
.gik-auto + .gik-auto{margin-top:14px;}
.gik-spinner{width:34px;height:34px;border:3px solid var(--brand-tint,rgba(80,158,47,.12));border-top-color:var(--brand,#509E2F);border-radius:50%;animation:gik-spin .7s linear infinite;margin:30px auto;}
@keyframes gik-spin{to{transform:rotate(360deg);}}
.gik-loading{min-height:60vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;color:var(--muted);font-weight:600;}
`;

// ---- Inline icons (same convention as the boarding card) ------------------
const Svg = (p: { d?: string; children?: ReactNode; sw?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={p.sw ?? 2} strokeLinecap="round" strokeLinejoin="round">
    {p.d ? <path d={p.d} /> : p.children}
  </svg>
);
const Icons = {
  key: <Svg><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></Svg>,
  wifi: <Svg><path d="M5 12.55a11 11 0 0 1 14.08 0" /><path d="M1.42 9a16 16 0 0 1 21.16 0" /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><path d="M12 20h.01" /></Svg>,
  clock: <Svg><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></Svg>,
  car: <Svg><path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2" /><circle cx="7" cy="17" r="2" /><path d="M9 17h6" /><circle cx="17" cy="17" r="2" /></Svg>,
  home: <Svg><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 22V12h6v10" /></Svg>,
  book: <Svg><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></Svg>,
  map: <Svg><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></Svg>,
  phone: <Svg><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" /></Svg>,
  compass: <Svg><circle cx="12" cy="12" r="10" /><path d="M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" /></Svg>,
  plane: <Svg><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" /></Svg>,
  back: <Svg><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></Svg>,
  keypad: <Svg><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M9 7h.01M12 7h.01M15 7h.01M9 11h.01M12 11h.01M15 11h.01M9 15h.01M12 15h.01M15 15h.01M12 19h.01" /></Svg>,
  info: <Svg><circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" /></Svg>,
};

// Some PMS profiles store names all-lowercase ("carine") — greet politely.
function capitalizeName(name: string): string {
  return name.replace(/(^|[\s-])(\S)/g, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

// Standard WiFi-join QR payload (WIFI:T:WPA;S:<ssid>;P:<pass>;;) — phones open
// the join dialog straight from the camera. Special chars must be escaped.
function wifiQrValue(network: string, password: string | null): string {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, "\\$1");
  return password
    ? `WIFI:T:WPA;S:${esc(network)};P:${esc(password)};;`
    : `WIFI:T:nopass;S:${esc(network)};;`;
}

// Minimal text rendering: blank line = paragraph break, consecutive lines
// starting with "- " become a bullet list, a line starting with "## " becomes
// a subheading. No markdown library.
function renderInfoText(text: string): ReactNode[] {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n\s*\n/);
  return blocks.map((block, i) => {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every((l) => l.startsWith("- "))) {
      return (
        <ul key={i}>
          {lines.map((l, j) => <li key={j}>{l.slice(2)}</li>)}
        </ul>
      );
    }
    if (lines.length === 1 && lines[0].startsWith("## ")) {
      return <h3 key={i}>{lines[0].slice(3)}</h3>;
    }
    return <p key={i}>{lines.join(" ")}</p>;
  });
}

// Reset to the home grid after a stretch with no touches — a guest walked away
// mid-flow and the next guest must not see their result on a shared screen.
function useIdleReset(timeoutMs: number, onIdle: () => void) {
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;
  useEffect(() => {
    let timer = window.setTimeout(() => onIdleRef.current(), timeoutMs);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => onIdleRef.current(), timeoutMs);
    };
    const events: Array<keyof WindowEventMap> = ["pointerdown", "touchstart", "scroll", "keydown"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [timeoutMs]);
}

const IDLE_RESET_MS = 75_000;
const RESULT_AUTO_CLOSE_MS = 60_000;
const REFETCH_MS = 5 * 60_000;

type PanelId = "doorcode" | "wifi" | "checkin" | "parking" | "earlycheckin" | "latecheckout" | "easyaccess" | "gettingAround" | "contact" | "explore" | "airport";

// Early check-in flow types (kiosk → /api/public/early-checkin/*)
interface EcOption { from: string; label: string; hours: number; dkk: number; eur: number }
interface EcQuote {
  inspected: boolean;
  firstName: string | null;
  capsule: string;
  options?: EcOption[];
  hours: number;
  dkk: number;
  eur: number;
}

interface LcOption { until: string; label: string; hours: number; dkk: number; eur: number }
interface LcQuote { firstName: string | null; capsule: string; currentEnd: string; options: LcOption[] }

// Receipt returned by the status poll once a purchase completes (both kinds)
interface PurchaseReceipt {
  id: string; // row id — used for the email-receipt endpoint
  kind: string;
  capsule: string;
  code: string | null;
  amount: string | null;
  currency: string;
  hours: number | null;
  accessFrom: string;
  accessUntil: string;
  paidAt: string | null;
}

// Flight board panel — fetches via our proxy on open, refreshes every 2 min
// while open. Kept as its own component so the interval lives with the panel.
function FlightBoard({ hotelSlug }: { hotelSlug: string }) {
  const [flights, setFlights] = useState<FlightsData | null>(null);
  const [failed, setFailed] = useState(false);
  const [direction, setDirection] = useState<"departures" | "arrivals">("departures");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`/api/public/airport-flights/${hotelSlug}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((data: FlightsData) => {
          if (cancelled) return;
          setFlights(data);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    load();
    const interval = window.setInterval(load, 2 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hotelSlug]);

  if (failed && !flights) return <p>Live flight data is unavailable right now. Please check cph.dk.</p>;
  if (!flights) return <div className="gik-spinner" />;

  const rows = flights[direction].slice(0, 14);
  return (
    <>
      <div className="gik-flhead">
        <div className="gik-fltoggle">
          <button className={direction === "departures" ? "on" : ""} onClick={() => setDirection("departures")}>Departures</button>
          <button className={direction === "arrivals" ? "on" : ""} onClick={() => setDirection("arrivals")}>Arrivals</button>
        </div>
        {/* Live security-queue widget. sandbox (no allow-top-navigation) so taps
            inside it can never navigate the kiosk away from the info screen. */}
        <iframe
          className="gik-secwait"
          src="https://cphsecuritywait.dk/en/widget?variant=compact"
          width={260}
          height={150}
          title="CPH security wait time"
          loading="lazy"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
      <div className="gik-flboard">
        <div className="gik-flrow head">
          <span>Time</span><span>Flight</span><span>{direction === "departures" ? "Destination" : "From"}</span><span>Gate</span><span className="st">Status</span>
        </div>
        {rows.map((f, i) => (
          <div className="gik-flrow" key={i}>
            <span className="tm">
              {f.delayed && f.expectedTime !== f.scheduledTime ? (
                <><s>{f.scheduledTime}</s> <b className="late">{f.expectedTime}</b></>
              ) : (
                <b>{f.expectedTime || f.scheduledTime}</b>
              )}
            </span>
            <span className="fn">{f.flightNumber}</span>
            <span className="ci">{f.city}</span>
            <span className="gt">{f.gate || "–"}</span>
            <span className={`st${f.delayed ? " late" : ""}`}>{f.status}</span>
          </div>
        ))}
      </div>
      <p className="gik-flfoot">Flight data provided by Copenhagen Airport{flights.lastUpdated ? ` · updated ${new Date(flights.lastUpdated).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : ""}</p>
    </>
  );
}

export default function InfoScreenPage() {
  const params = useParams<{ hotel: string }>();
  // Guide mode (29/7): the same screen mounted at /:hotel/guide is the
  // guest's MOBILE guide — no kiosk behaviors (idle reset, reloads), no
  // door-code lookup tile, purchases via the phone-first /extras flow.
  const [isGuide] = useRoute("/:hotel/guide");
  const [info, setInfo] = useState<GuestInfoData | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [panel, setPanel] = useState<PanelId | null>(null);

  // Door-code lookup state
  const [lastName, setLastName] = useState("");
  const [resNumber, setResNumber] = useState("");
  const [needsResNumber, setNeedsResNumber] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [result, setResult] = useState<DoorCodeResponse | null>(null);
  // Kiosk token (setting guest_info_token): arrives once as ?k=… on the
  // tablet's URL and is remembered locally, so the bare-domain redirect and
  // later reloads keep working without the parameter.
  const [kioskToken] = useState<string | null>(() => {
    try {
      const key = `kioskToken:${params.hotel ?? ""}`;
      const fromUrl = new URLSearchParams(window.location.search).get("k");
      if (fromUrl) {
        localStorage.setItem(key, fromUrl);
        return fromUrl;
      }
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  });

  const resetLookup = useCallback(() => {
    setLastName("");
    setResNumber("");
    setNeedsResNumber(false);
    setLookupLoading(false);
    setLookupError(null);
    setResult(null);
  }, []);

  // Early check-in flow state
  const [ecCode, setEcCode] = useState("");
  const [ecLoading, setEcLoading] = useState(false);
  const [ecError, setEcError] = useState<string | null>(null);
  const [ecQuote, setEcQuote] = useState<EcQuote | null>(null);
  const [ecPayment, setEcPayment] = useState<{ id: string; paymentUrl: string; dkk: number; eur: number } | null>(null);
  const [ecPaid, setEcPaid] = useState(false);
  const [ecExpired, setEcExpired] = useState(false);
  const [ecEmail, setEcEmail] = useState("");
  const [ecWaitlisted, setEcWaitlisted] = useState(false);

  const resetEarlyCheckin = useCallback(() => {
    setEcCode("");
    setEcLoading(false);
    setEcError(null);
    setEcQuote(null);
    setEcPayment(null);
    setEcPaid(false);
    setEcExpired(false);
    setEcEmail("");
    setEcWaitlisted(false);
  }, []);

  // Late checkout flow state
  const [lcCode, setLcCode] = useState("");
  const [lcLoading, setLcLoading] = useState(false);
  const [lcError, setLcError] = useState<string | null>(null);
  const [lcQuote, setLcQuote] = useState<LcQuote | null>(null);
  const [lcPayment, setLcPayment] = useState<{ id: string; paymentUrl: string; dkk: number; eur: number; label: string } | null>(null);
  const [lcPaid, setLcPaid] = useState(false);
  const [lcExpired, setLcExpired] = useState(false);

  const resetLateCheckout = useCallback(() => {
    setLcCode("");
    setLcLoading(false);
    setLcError(null);
    setLcQuote(null);
    setLcPayment(null);
    setLcPaid(false);
    setLcExpired(false);
  }, []);

  // Purchase receipt (shared by both flows' confirmation pages)
  const [receipt, setReceipt] = useState<PurchaseReceipt | null>(null);
  const [receiptEmail, setReceiptEmail] = useState("");
  const [receiptSending, setReceiptSending] = useState(false);
  const [receiptSent, setReceiptSent] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);

  const resetReceipt = useCallback(() => {
    setReceipt(null);
    setReceiptEmail("");
    setReceiptSending(false);
    setReceiptSent(false);
    setReceiptError(null);
  }, []);

  const goHome = useCallback(() => {
    setPanel(null);
    resetLookup();
    resetEarlyCheckin();
    resetLateCheckout();
    resetReceipt();
  }, [resetLookup, resetEarlyCheckin, resetLateCheckout, resetReceipt]);

  // Idle reset must NOT fire while a payment QR is on screen — the guest is
  // busy paying on their phone, not touching the kiosk. (The ref-based hook
  // always calls the latest closure, so this sees fresh state.)
  useIdleReset(IDLE_RESET_MS, () => {
    if (isGuide) return; // the guest's own phone — never reset under them
    if (ecPayment && !ecPaid && !ecExpired) return;
    if (lcPayment && !lcPaid && !lcExpired) return;
    goHome();
  });

  // Result auto-dismiss: personal data must not linger on a shared screen.
  useEffect(() => {
    if (!result || result.multiple) return;
    const timer = window.setTimeout(goHome, RESULT_AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [result, goHome]);

  // Nightly full reload (~04:30) so a long-running kiosk tablet picks up new
  // app builds — the 5-min refetch below only refreshes data, not the bundle.
  useEffect(() => {
    if (isGuide) return; // wall-tablet concern only
    const timer = window.setInterval(() => {
      const now = new Date();
      if (now.getHours() === 4 && now.getMinutes() === 30) window.location.reload();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [isGuide]);

  // Deploy-drift reload (25/7: a fix shipped mid-day, but the wall tablet ran
  // the OLD bundle until 04:30 and kept showing the bug to guests). Every 10
  // min, compare the served index.html's bundle hash with the one actually
  // running; on drift, reload — but only from the idle home screen, never
  // mid-flow or with a payment QR up, and at most once per 30 min
  // (sessionStorage guard) so a misbehaving cache can't reload-loop the kiosk.
  useEffect(() => {
    if (isGuide) return; // wall-tablet concern only
    const timer = window.setInterval(async () => {
      try {
        if (panel !== null) return; // guest mid-flow — wait for idle
        const running = (document.querySelector('script[src*="/assets/index-"]') as HTMLScriptElement | null)
          ?.src.match(/index-[\w-]+\.js/)?.[0];
        if (!running) return;
        const res = await fetch(`/?bundlecheck=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) return;
        const served = (await res.text()).match(/index-[\w-]+\.js/)?.[0];
        if (!served || served === running) return;
        const last = parseInt(sessionStorage.getItem("kiosk-auto-reload-at") || "0", 10);
        if (Date.now() - last < 30 * 60_000) return;
        sessionStorage.setItem("kiosk-auto-reload-at", String(Date.now()));
        window.location.reload();
      } catch { /* offline/transient — next tick */ }
    }, 10 * 60_000);
    return () => window.clearInterval(timer);
  }, [panel, isGuide]);

  // Fetch content, then refetch every 5 min so admin edits reach the tablet
  // without a reload. On failure keep the last good data — never blank out.
  useEffect(() => {
    if (!params.hotel) return;
    let cancelled = false;
    const load = () => {
      fetch(`/api/public/guest-info/${params.hotel}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
        .then((data: GuestInfoData) => {
          if (cancelled) return;
          setInfo(data);
          setLoadFailed(false);
          document.title = `Guest Info – ${data.name}`;
        })
        .catch(() => {
          if (!cancelled) setLoadFailed((prev) => prev || true);
        });
    };
    load();
    const interval = window.setInterval(load, REFETCH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [params.hotel]);

  const theme = info?.theme || null;
  useGuestFont(theme?.font);
  useFavicon(theme?.logoUrl, theme?.brand);

  const handleLookup = async (e: FormEvent) => {
    e.preventDefault();
    if (!params.hotel) return;
    const queryTrim = lastName.trim();
    if (queryTrim.length < 2) {
      setLookupError("Please enter your last name or booking number (at least 2 characters).");
      return;
    }
    setLookupError(null);
    setLookupLoading(true);
    try {
      const response = await fetch("/api/public/kiosk-door-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hotelSlug: params.hotel,
          query: queryTrim,
          reservationNumber: resNumber.trim() || undefined,
          kioskToken: kioskToken || undefined,
        }),
      });
      const data: DoorCodeResponse = await response.json();
      if (!response.ok) {
        if (response.status === 429) {
          setLookupError("Too many attempts. Please contact reception.");
        } else {
          setLookupError(data.error || "No matching reservation found. Please check the spelling and date, or contact reception.");
        }
        return;
      }
      if (data.multiple) {
        setNeedsResNumber(true);
        setLookupError(`${data.count} reservations match that name. Please also enter your booking number — from Booking.com, Hostelworld, Expedia or your confirmation email.`);
        return;
      }
      setResult(data);
    } catch {
      setLookupError("Network error. Please try again.");
    } finally {
      setLookupLoading(false);
    }
  };

  // ── Early check-in handlers ────────────────────────────────────────────────
  const ecReasonMessage = (reason: string): string => {
    switch (reason) {
      case "not_found": return "We couldn't find a booking with that door code. Please check the code in your SMS or email.";
      case "already_checked_in": return "You're already checked in — your door code works.";
      case "already_active": return "Your door code is already active — just type it on the keypad.";
      case "already_bought": return "You've already bought early check-in — your door code starts working at the time you picked.";
      case "owing": return "There's an outstanding balance on your booking. Please settle it via the payment link in your email first.";
      case "too_early": return "Early check-in isn't open for your arrival date yet.";
      case "occupied": return "Your capsule is still occupied by the previous guest — early check-in opens as soon as they've checked out.";
      case "not_inspected": return "Your capsule isn't ready yet.";
      case "already_inspected": return "Good news — your capsule is ready! Look up your code again to pay and get in.";
      case "mews_unavailable": return "Payment is starting up — please try again in a minute.";
      default: return "Early check-in isn't available right now. Please try again later.";
    }
  };

  const runEcLookup = async (code: string) => {
    if (!/^\d{4,8}$/.test(code)) { setEcError("Please type your 4-digit door code."); return; }
    setEcLoading(true);
    setEcError(null);
    try {
      const response = await fetch("/api/public/early-checkin/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // source: funnel marker only (server logs extras vs kiosk lookups)
        body: JSON.stringify({ hotelSlug: params.hotel, doorCode: code, source: "kiosk" }),
      });
      if (response.status === 429) { setEcError("Too many attempts. Please wait a bit."); return; }
      const data = await response.json();
      if (!data.ok) { setEcError(ecReasonMessage(data.reason)); return; }
      setEcQuote(data);
    } catch {
      setEcError("Network error. Please try again.");
    } finally {
      setEcLoading(false);
    }
  };

  const handleEcLookup = async (e: FormEvent) => {
    e.preventDefault();
    await runEcLookup(ecCode.trim());
  };

  // Bridge from the door-code lookup: the guest's code isn't active yet, but
  // they're standing here — jump straight into Early check-in with the code
  // prefilled and the quote loading, so activation is one payment away.
  const startEarlyCheckinWithCode = (code: string) => {
    resetEarlyCheckin();
    resetLookup();
    // Entering the flow fresh must also drop any lingering confirmation from
    // the previous kiosk guest (defense in depth vs the pay-time guard).
    resetReceipt();
    setEcCode(code);
    setPanel("earlycheckin");
    void runEcLookup(code);
  };

  const handleEcPay = async (from?: string) => {
    setEcLoading(true);
    setEcError(null);
    try {
      const response = await fetch("/api/public/early-checkin/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelSlug: params.hotel, doorCode: ecCode.trim(), ...(from ? { from } : {}) }),
      });
      const data = await response.json();
      if (!data.ok) { setEcError(ecReasonMessage(data.reason)); return; }
      // KIOSK CROSS-GUEST GUARD (Guiotto/724-hændelsen 24/7): a NEW payment
      // must wipe every trace of the PREVIOUS guest's session. With stale
      // ecPaid=true the poll effect never watched the new payment, the screen
      // kept showing the previous guest's confirmation (their capsule!), and
      // the receipt form emailed guest A's receipt to guest B — who walked
      // away believing they had paid and were assigned the wrong capsule.
      setEcPaid(false);
      setEcExpired(false);
      resetReceipt();
      setEcPayment({ id: data.id, paymentUrl: data.paymentUrl, dkk: data.dkk, eur: data.eur });
    } catch {
      setEcError("Network error. Please try again.");
    } finally {
      setEcLoading(false);
    }
  };

  const handleEcWaitlist = async (e: FormEvent) => {
    e.preventDefault();
    setEcLoading(true);
    setEcError(null);
    try {
      const response = await fetch("/api/public/early-checkin/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelSlug: params.hotel, doorCode: ecCode.trim(), email: ecEmail.trim() }),
      });
      const data = await response.json();
      if (!data.ok) { setEcError(data.error || ecReasonMessage(data.reason)); return; }
      setEcWaitlisted(true);
    } catch {
      setEcError("Network error. Please try again.");
    } finally {
      setEcLoading(false);
    }
  };

  const lcReasonMessage = (reason: string): string => {
    switch (reason) {
      case "not_ready": return "Late check-out isn't available for your booking yet. Please contact reception.";
      case "already_active": return "The checkout time has already passed. Please contact us if you need help.";
      case "too_early": return "Late check-out can be bought on your departure day.";
      case "not_available": return "Late check-out isn't available for your capsule today — it's booked right after your stay.";
      case "mews_unavailable": return "Payment is starting up — please try again in a minute.";
      case "not_found": return "We couldn't find a booking with that door code. Please check the code in your SMS or email.";
      case "owing": return "There's an outstanding balance on your booking. Please settle it via the payment link in your email first.";
      // NEVER fall through to the early check-in texts (24/7: a guest buying
      // late check-out was told "Early check-in isn't available" — nonsense
      // in this panel).
      default: return "Late check-out isn't available right now. Please try again in a moment.";
    }
  };

  const handleLcLookup = async (e: FormEvent) => {
    e.preventDefault();
    const code = lcCode.trim();
    if (!/^\d{4,8}$/.test(code)) { setLcError("Please type your 4-digit door code."); return; }
    setLcLoading(true);
    setLcError(null);
    try {
      const response = await fetch("/api/public/late-checkout/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // source: funnel marker only (server logs extras vs kiosk lookups)
        body: JSON.stringify({ hotelSlug: params.hotel, doorCode: code, source: "kiosk" }),
      });
      if (response.status === 429) { setLcError("Too many attempts. Please wait a bit."); return; }
      const data = await response.json();
      if (!data.ok) { setLcError(lcReasonMessage(data.reason)); return; }
      setLcQuote(data);
    } catch {
      setLcError("Network error. Please try again.");
    } finally {
      setLcLoading(false);
    }
  };

  const handleLcPay = async (option: LcOption) => {
    setLcLoading(true);
    setLcError(null);
    try {
      const response = await fetch("/api/public/late-checkout/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelSlug: params.hotel, doorCode: lcCode.trim(), until: option.until }),
      });
      if (response.status === 429) { setLcError("Too many attempts. Please wait a bit."); return; }
      const data = await response.json();
      if (!data.ok) { setLcError(lcReasonMessage(data.reason)); return; }
      // Same cross-guest guard as handleEcPay: a new payment wipes the
      // previous guest's confirmation/receipt state.
      setLcPaid(false);
      setLcExpired(false);
      resetReceipt();
      setLcPayment({ id: data.id, paymentUrl: data.paymentUrl, dkk: data.dkk, eur: data.eur, label: data.label });
    } catch {
      setLcError("Network error. Please try again.");
    } finally {
      setLcLoading(false);
    }
  };

  // Poll payment status every 4s while a QR is on screen. The guest pays on
  // their own phone; the kiosk flips to success the moment MEWS confirms.
  // (Late checkout reuses the same status endpoint — rows carry their kind.)
  useEffect(() => {
    const active = ecPayment && !ecPaid && !ecExpired
      ? { id: ecPayment.id, onPaid: () => setEcPaid(true), onExpired: () => setEcExpired(true) }
      : lcPayment && !lcPaid && !lcExpired
        ? { id: lcPayment.id, onPaid: () => setLcPaid(true), onExpired: () => setLcExpired(true) }
        : null;
    if (!active) return;
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/public/early-checkin/${active.id}?hotel=${encodeURIComponent(params.hotel || "")}`);
        if (!response.ok) return;
        const data = await response.json();
        if (data.granted) {
          if (data.receipt) setReceipt({ ...data.receipt, id: active.id });
          active.onPaid();
        } else if (data.status === "expired") active.onExpired();
      } catch { /* transient — keep polling */ }
    }, 4000);
    return () => window.clearInterval(interval);
  }, [ecPayment, ecPaid, ecExpired, lcPayment, lcPaid, lcExpired, params.hotel]);

  // Success screen auto-dismiss (shared kiosk — don't linger with guest data).
  // Longer than the normal result timeout so the guest can type a receipt email.
  useEffect(() => {
    if (!ecPaid && !ecWaitlisted && !lcPaid) return;
    const timer = window.setTimeout(goHome, 150_000);
    return () => window.clearTimeout(timer);
  }, [ecPaid, ecWaitlisted, lcPaid, goHome]);

  const handleSendReceipt = async (e: FormEvent) => {
    e.preventDefault();
    if (!receipt) return;
    setReceiptSending(true);
    setReceiptError(null);
    try {
      const response = await fetch(`/api/public/early-checkin/${receipt.id}/receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotelSlug: params.hotel, email: receiptEmail.trim() }),
      });
      const data = await response.json();
      if (!data.ok) { setReceiptError(data.error || "Could not send the receipt. Please try again."); return; }
      setReceiptSent(true);
    } catch {
      setReceiptError("Network error. Please try again.");
    } finally {
      setReceiptSending(false);
    }
  };

  // Shared confirmation card: what was bought, capsule, door code, times, price.
  const renderReceiptCard = () => {
    if (!receipt) return null;
    const kindLabel = receipt.kind === "late_checkout" ? "Late check-out" : "Early check-in";
    return (
      <>
        <div className="gik-bigrow">
          <div className="gik-bigbox">
            <div className="k">Capsule</div>
            <div className="v plain">{receipt.capsule}</div>
          </div>
          {receipt.code && (
            <div className="gik-bigbox">
              <div className="k">Your door code</div>
              <div className="v">{receipt.code}#</div>
            </div>
          )}
        </div>
        <div className="gik-auto">
          <div className="ttl">{kindLabel} — paid {receipt.amount} {receipt.currency}</div>
          <ul>
            <li>Purchased: <b>{kindLabel}{receipt.hours ? ` (${receipt.hours} ${receipt.hours === 1 ? "hour" : "hours"})` : ""}</b></li>
            <li>Your code works <b>from {fmtValidity(receipt.accessFrom)}</b> <b>until {fmtValidity(receipt.accessUntil)}</b></li>
            {receipt.paidAt && <li>Payment received: {fmtValidity(receipt.paidAt)}</li>}
          </ul>
        </div>
        {receiptSent ? (
          <div className="gik-auto">
            <div className="ttl">Receipt sent to {receiptEmail.trim()} ✅</div>
          </div>
        ) : (
          <>
            <p style={{ marginTop: 16 }}>Want this receipt by email?</p>
            <form className="gik-lookup" onSubmit={handleSendReceipt}>
              <div>
                <label htmlFor="gik-receipt-email">Email</label>
                <input
                  id="gik-receipt-email"
                  type="email"
                  autoComplete="off"
                  value={receiptEmail}
                  onChange={(e) => { setReceiptEmail(e.target.value); setReceiptError(null); }}
                  placeholder="you@example.com"
                  disabled={receiptSending}
                />
              </div>
              <button type="submit" disabled={receiptSending || !receiptEmail.includes("@")}>
                {receiptSending ? "Sending…" : "Send receipt"}
              </button>
            </form>
            {receiptError && <div className="gik-err">{receiptError}</div>}
          </>
        )}
      </>
    );
  };

  const fmtValidity = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  const reasonNotice = (reason: DoorCodeEntry["reason"]) => {
    if (reason === "already_checked_in") {
      return { ttl: "Already checked in", sub: "You are already checked in, so your code isn't shown here. Find it in your SMS or email — or contact reception if you need help." };
    }
    if (reason === "payment") {
      return { ttl: "Payment required", sub: "There is an outstanding balance on your reservation, so your door code is not active yet. Please contact reception to settle it — your code will work right after." };
    }
    if (reason === "not_checked_in") {
      return { ttl: "Check-in required", sub: "Your door code becomes available once you are checked in. Please contact reception." };
    }
    return { ttl: "Code not ready yet", sub: "Your door code isn't active yet. Please try again closer to check-in time, or contact reception." };
  };

  if (!info) {
    return (
      <div className="gik-root">
        <style>{KIOSK_CSS}</style>
        <div className="gik-app">
          <div className="gik-loading">
            {loadFailed ? <span>Guest info is not available.</span> : <div className="gik-spinner" />}
          </div>
        </div>
      </div>
    );
  }

  const brandName = theme?.showName || !theme?.logoUrl ? (theme?.name || info.name) : null;

  interface Tile { id: PanelId | "napstay"; title: string; sub: string; icon: ReactNode; hero?: boolean; show: boolean; href?: string }
  const tiles: Tile[] = [
    // Guide mode (29/7): the name+date door-code lookup is KIOSK-ONLY — on the
    // public mobile guide the tile is hidden (and the API is host-gated
    // server-side). Purchases go through the phone-first /extras flow instead
    // of the kiosk QR panels.
    { id: "doorcode", title: "Check in", sub: "Arriving today and no SMS or email? Look up your capsule and code here", icon: Icons.key, hero: true, show: !isGuide },
    { id: "wifi", title: "WiFi", sub: "Network and password", icon: Icons.wifi, show: !!info.wifi },
    { id: "easyaccess", title: "How to use your door code", sub: "Your code + # on the keypad · boarding card on your phone", icon: Icons.keypad, show: true },
    { id: "earlycheckin", title: "Early check-in", sub: `Arriving before ${info.checkInTime}? Get into your capsule now`, icon: Icons.clock, show: !!info.earlyCheckin, ...(isGuide ? { href: `/${params.hotel}/extras` } : {}) },
    { id: "latecheckout", title: "Late check-out", sub: `Need more time? Stay past ${info.checkOutTime}`, icon: Icons.clock, show: !!info.lateCheckout, ...(isGuide ? { href: `/${params.hotel}/extras` } : {}) },
    { id: "parking", title: "Parking", sub: info.parkingPaymentUrl ? "Garage on our level · pay here up to 48h after parking" : "Parking garage on our level & street parking", icon: Icons.car, show: !!(info.sections.parking || info.parkingPaymentUrl) },
    // "Check-in & check-out"-tilen er fjernet (20/7): tiderne fremgår af
    // Early check-in/Late check-out-tiles, og auto-check-in-forklaringen bor i
    // dørkode-panelet. Panel-koden for id "checkin" beholdes (uskadelig).
    { id: "gettingAround", title: "Getting around", sub: "Address and transport", icon: Icons.map, show: !!(info.sections.gettingAround || info.address) },
    { id: "airport", title: "Airport", sub: "Live departures & arrivals at CPH", icon: Icons.plane, show: info.hasFlights },
    { id: "contact", title: "Help & contact", sub: "Reach us if you need anything", icon: Icons.phone, show: !!(info.sections.contact || info.contactPhone) },
    { id: "explore", title: "Explore Copenhagen", sub: "Our neighbourhood tips", icon: Icons.compass, show: !!info.sections.explore },
    // Bottom hero (owner request 24/7): instant nap-stay booking straight on
    // the screen — opens the guest hourly-booking flow (packages from the
    // hourly_products setting, pay here, capsule + code on the confirmation).
    {
      id: "napstay",
      title: "Quick book — Nap stay",
      sub: "Need a capsule right now? Book by the hour and get your door code instantly",
      icon: Icons.clock,
      hero: true,
      show: true,
      href: isGuide ? `/${params.hotel}/hourly` : `/${params.hotel}/hourly?kiosk=1`,
    },
  ];

  const panelTitle = (id: PanelId) => tiles.find((t) => t.id === id);

  // Shown under "Check-in & check-out": access is fully automatic, so the guest
  // never has to do anything at reception. (The door-code lookup page states the
  // same point inline in its intro box instead of repeating this card.)
  const autoAccessNote = (
    <div className="gik-auto">
      <div className="ttl">Check-in & check-out happen automatically</div>
      <ul>
        <li>The <b>first time you type your door code</b>, you are checked in automatically.</li>
        <li>On your <b>departure day</b> you are checked out automatically.</li>
        <li>That's all — there is <b>nothing else you need to do</b>.</li>
      </ul>
    </div>
  );

  const renderPanelBody = (id: PanelId) => {
    if (id === "doorcode") {
      if (result && !result.multiple) {
        return (
          <div className="gik-result">
            <div className="hi">Hi {capitalizeName(result.firstName || "")}!</div>
            {/* Owner copy (8/9): only when a code is actually shown — a guest
                held back for payment / not-ready is NOT checked in. */}
            {(result.results || []).some((e) => !!e.pin) && (
              <div className="easy" data-testid="doorcode-easy">Easy, you are now checked in!</div>
            )}
            {(result.results || []).map((entry, idx) => {
              const notice = entry.reason ? reasonNotice(entry.reason) : null;
              return (
                <div className={idx > 0 ? "gik-codeblock" : undefined} key={idx}>
                  {entry.capsule && (
                    <div className="capsule">
                      {/^capsule\b/i.test(entry.capsule) ? entry.capsule : `Capsule ${entry.capsule}`}
                    </div>
                  )}
                  {entry.pin ? (
                    <>
                      <div className="gik-digits">
                        {entry.pin.code.split("").map((d, i) => <span className="d" key={i}>{d}</span>)}
                        <span className="d hash">#</span>
                      </div>
                      <div className="gik-keyhint">Type the code and finish with #</div>
                      {(entry.pin.validFrom || entry.pin.validTo) && (
                        <div className="gik-valid">
                          Valid <b>{fmtValidity(entry.pin.validFrom)}</b> – <b>{fmtValidity(entry.pin.validTo)}</b>
                        </div>
                      )}
                      {info.earlyCheckin && entry.pin.validFrom && new Date(entry.pin.validFrom).getTime() > Date.now() && (
                        <button
                          type="button"
                          className="gik-ec-cta"
                          onClick={() => startEarlyCheckinWithCode(entry.pin!.code)}
                          data-testid="doorcode-ec-cta"
                        >
                          Arriving now? Get into your capsule right away
                          <span className="sub">Your code first works from {fmtValidity(entry.pin.validFrom)} — tap here to buy Early check-in and activate it now</span>
                        </button>
                      )}
                    </>
                  ) : notice ? (
                    <div className="gik-notice">
                      <div className="ttl">{notice.ttl}</div>
                      <div className="sub">{notice.sub}</div>
                    </div>
                  ) : null}
                </div>
              );
            })}
            <div className="gik-video" style={{ margin: "18px auto 0" }}>
              <video src="/ttlock-door-code.mp4" autoPlay loop muted playsInline />
            </div>
            <div className="gik-usednote">Once you use a code on the keypad you are checked in — after that, your code is no longer shown here.</div>
            <div className="gik-countdown">This screen closes automatically.</div>
          </div>
        );
      }
      return (
        <>
          <div className="gik-auto">
            <div className="ttl">Already got your code?</div>
            <p>Your door code is sent by SMS and email about 24 hours before check-in. If you already have it, you don't need this — just use that code on the keypad.</p>
            <p style={{ marginTop: 10 }}>Check-in and check-out happen automatically — that's all, there is nothing else you need to do.</p>
          </div>
          <p style={{ marginTop: 22 }}>Didn't get it, or arriving today? Enter your last name — or the booking number from Booking.com, Hostelworld, Expedia or your confirmation email — to see your capsule number and door code.</p>
          <form className="gik-lookup" onSubmit={handleLookup}>
            <div>
              <label htmlFor="gik-lastname">Last name or booking number</label>
              <input
                id="gik-lastname"
                type="text"
                autoComplete="off"
                value={lastName}
                onChange={(e) => { setLastName(e.target.value); setLookupError(null); }}
                placeholder="Your surname, or your booking number"
                disabled={lookupLoading}
              />
            </div>
            {needsResNumber && (
              <div>
                <label htmlFor="gik-resnum">Booking number</label>
                <input
                  id="gik-resnum"
                  type="text"
                  autoComplete="off"
                  value={resNumber}
                  onChange={(e) => { setResNumber(e.target.value); setLookupError(null); }}
                  placeholder="From Booking.com, Hostelworld, Expedia or your confirmation email"
                  disabled={lookupLoading}
                />
              </div>
            )}
            <button type="submit" disabled={lookupLoading}>
              {lookupLoading ? "Searching…" : "Show my door code"}
            </button>
          </form>
          {lookupError && <div className="gik-err">{lookupError}</div>}
        </>
      );
    }
    if (id === "wifi") {
      if (!info.wifi) return null;
      return (
        <>
          <div className="gik-qrwrap">
            <div className="gik-qr">
              <QRCodeSVG value={wifiQrValue(info.wifi.network, info.wifi.password)} size={240} level="M" />
            </div>
            <p className="gik-qrhint">Scan with your phone camera to connect</p>
          </div>
          <div className="gik-bigrow">
            <div className="gik-bigbox">
              <div className="k">Network</div>
              <div className="v plain">{info.wifi.network}</div>
            </div>
            {info.wifi.password && (
              <div className="gik-bigbox">
                <div className="k">Password</div>
                <div className="v">{info.wifi.password}</div>
              </div>
            )}
          </div>
        </>
      );
    }
    if (id === "checkin") {
      return (
        <>
          <div className="gik-bigrow">
            <div className="gik-bigbox">
              <div className="k">Check-in from</div>
              <div className="v">{info.checkInTime}</div>
            </div>
            <div className="gik-bigbox">
              <div className="k">Check-out by</div>
              <div className="v">{info.checkOutTime}</div>
            </div>
          </div>
          {autoAccessNote}
          {info.sections.checkin && renderInfoText(info.sections.checkin)}
        </>
      );
    }
    if (id === "airport") {
      return <FlightBoard hotelSlug={params.hotel || ""} />;
    }
    if (id === "easyaccess") {
      // QR points at the tenant's public PIN check-in page — the guest enters
      // their door code on their own phone and lands on their boarding card.
      // Static URL, nothing personal, safe to show on a shared screen.
      const checkinUrl = `${window.location.origin}/${params.hotel}/checkin`;
      return (
        <>
          <p>There are two ways to open the doors — pick whichever you prefer:</p>
          <div className="gik-opthead">
            <span className="num">1</span>
            <span className="ttl">Just use your door code</span>
          </div>
          <div className="gik-howto">
            <div className="txt">
              <p>Your 4-digit door code works on the keypads — on the entrance doors and on your own capsule:</p>
              <ul>
                <li>Touch the keypad so the numbers light up</li>
                <li>Type your 4-digit door code</li>
                <li>Finish with the # key — the lock opens</li>
              </ul>
              <div className="gik-digits">
                {["•", "•", "•", "•"].map((d, i) => <span className="d" key={i}>{d}</span>)}
                <span className="d hash">#</span>
              </div>
              <div className="gik-keyhint" style={{ textAlign: "center" }}>Your code + # — that's it</div>
            </div>
            <div className="gik-video">
              <video src="/ttlock-door-code.mp4" autoPlay loop muted playsInline />
            </div>
          </div>
          <div className="gik-codeblock">
            <div className="gik-opthead" style={{ marginTop: 0 }}>
              <span className="num">2</span>
              <span className="ttl">Boarding card on your phone</span>
            </div>
            <p>Scan the QR code with your phone camera and type your door code. Your personal boarding card opens with your capsule number, your code and buttons to unlock the doors straight from your phone.</p>
            <div className="gik-qrwrap">
              <div className="gik-qr">
                <QRCodeSVG value={checkinUrl} size={240} level="M" />
              </div>
              <p className="gik-qrhint">Scan to open your boarding card</p>
            </div>
          </div>
        </>
      );
    }
    if (id === "gettingAround") {
      return (
        <>
          {info.address && (
            <div className="gik-bigrow">
              <div className="gik-bigbox">
                <div className="k">Address</div>
                <div className="v plain">{info.address}</div>
              </div>
            </div>
          )}
          {info.sections.gettingAround && renderInfoText(info.sections.gettingAround)}
        </>
      );
    }
    if (id === "parking" && info.parkingPaymentUrl) {
      // Payment-first parking panel (the pay link is THE solution): pay on your
      // own phone via QR, or tap the button when viewing this page on a phone.
      return (
        <>
          <div className="gik-auto">
            <div className="ttl">Parking garage on our level (P6)</div>
            <ul>
              <li>Enter from <b>Ålandsgade 37</b> and follow the signs to <b>Level P6</b> — you can walk straight from the garage into the hotel.</li>
              <li>Price: <b>DKK 13 per started 30 minutes</b>.</li>
              <li><b>Vehicle entry is only possible between 07:00 and 22:00.</b> You can drive out at any time — the exit is open 24/7.</li>
            </ul>
          </div>
          <div className="gik-codeblock">
            <div className="gik-opthead" style={{ marginTop: 0 }}>
              <span className="ttl">Pay for your parking here — up to 48 hours after you parked</span>
            </div>
            <div className="gik-qrwrap">
              <div className="gik-qr">
                <QRCodeSVG value={info.parkingPaymentUrl} size={240} level="M" />
              </div>
              <p className="gik-qrhint">Scan with your phone camera to open the payment page</p>
            </div>
          </div>
        </>
      );
    }
    if (id === "earlycheckin") {
      const ec = info.earlyCheckin;
      if (!ec) return null;
      const perHourEur = Math.round(ec.pricePerHour / ec.eurRate);

      if (ecPaid) {
        return (
          <div className="gik-result">
            <div className="hi">You're in{ecQuote?.firstName ? `, ${capitalizeName(ecQuote.firstName)}` : ""}! ✅</div>
            {receipt ? renderReceiptCard() : (
              <div className="gik-auto">
                <div className="ttl">Payment received — your door code works right now</div>
                <p>Your door code is <b>unchanged</b> — type it on the keypad and finish with <b>#</b>.</p>
              </div>
            )}
            <div className="gik-countdown">This screen closes automatically.</div>
          </div>
        );
      }

      if (ecPayment) {
        return (
          <div className="gik-result">
            <div className="hi">Scan to pay {ecPayment.dkk} kr <span style={{ color: "#6b7280", fontWeight: 400 }}>(≈ €{ecPayment.eur})</span></div>
            {ecExpired ? (
              <div className="gik-notice">
                <div className="ttl">Payment window expired</div>
                <div className="sub">No money was taken. Go back and try again.</div>
              </div>
            ) : (
              <>
                <div className="gik-qrwrap">
                  <div className="gik-qr">
                    <QRCodeSVG value={ecPayment.paymentUrl} size={240} level="M" />
                  </div>
                  <p className="gik-qrhint">Scan with your phone camera and pay on the secure payment page</p>
                </div>
                <form className="gik-lookup gik-payopen" onSubmit={(e) => { e.preventDefault(); window.open(ecPayment.paymentUrl, "_blank", "noopener"); }}>
                  <button type="submit">Pay on this phone (card form)</button>
                </form>
                <div className="gik-usednote">This screen updates automatically as soon as your payment is confirmed — usually within a few seconds.</div>
              </>
            )}
          </div>
        );
      }

      if (ecWaitlisted) {
        return (
          <div className="gik-result">
            <div className="hi">Thanks{ecQuote?.firstName ? `, ${capitalizeName(ecQuote.firstName)}` : ""}!</div>
            <div className="gik-auto">
              <div className="ttl">We'll email you the moment your capsule is ready</div>
              <p>Housekeeping is finishing up. As soon as your capsule is cleaned and inspected, you'll get an email at <b>{ecEmail}</b> — then come back to this screen to complete your early check-in.</p>
            </div>
            <div className="gik-countdown">This screen closes automatically.</div>
          </div>
        );
      }

      if (ecQuote) {
        return (
          <div className="gik-result">
            <div className="hi">Hi {capitalizeName(ecQuote.firstName || "")}!</div>
            <div className="gik-auto">
              <div className="ttl">
                {/^capsule/i.test(ecQuote.capsule) ? ecQuote.capsule : `Capsule ${ecQuote.capsule}`}
                {ecQuote.inspected ? " is ready — get in now" : " — get in now"}
              </div>
              {(ecQuote.options?.length ?? 0) > 1 ? (
                <p>Choose when your door code starts working — earlier costs a bit more:</p>
              ) : (
                <p>
                  Early check-in until {info.checkInTime}: <b>{ecQuote.dkk} kr</b>{" "}
                  <span style={{ color: "#6b7280" }}>(≈ €{ecQuote.eur})</span>
                </p>
              )}
              <p>Your door code stays <b>exactly the same</b> — it just starts working earlier instead of at {info.checkInTime}.</p>
            </div>
            {!ecQuote.inspected && (
              <div className="gik-notice">
                <div className="ttl">Your capsule gets priority cleaning</div>
                <div className="sub">Housekeeping is notified the moment you pay and will make your capsule ready right away.</div>
              </div>
            )}
            {(ecQuote.options ?? [{ from: "", label: "now", hours: ecQuote.hours, dkk: ecQuote.dkk, eur: ecQuote.eur }]).map((o) => (
              <form key={o.from || "now"} className="gik-lookup" onSubmit={(e) => { e.preventDefault(); handleEcPay(o.from || undefined); }}>
                <button type="submit" disabled={ecLoading}>
                  {ecLoading
                    ? "Preparing payment…"
                    : o.label === "now"
                      ? `Check in now — ${o.dkk} kr (≈ €${o.eur})`
                      : `From ${o.label} — ${o.dkk} kr (≈ €${o.eur})`}
                </button>
              </form>
            ))}
            {ecError && <div className="gik-err">{ecError}</div>}
          </div>
        );
      }

      return (
        <>
          <div className="gik-auto">
            <div className="ttl">Arriving before {info.checkInTime}?</div>
            {(ec.tiers?.length ?? 0) > 0 ? (
              <p>Get into your capsule earlier instead of waiting: {ec.tiers.map((t, i) => (
                <span key={t.label}>{i > 0 ? " · " : ""}from <b>{t.label}</b> — <b>{t.dkk} kr</b></span>
              ))} — paid on your phone, and your door code simply starts working from the time you pick.</p>
            ) : (
              <p>Get into your capsule right away instead of waiting. Price: <b>{ec.pricePerHour} kr</b> <span style={{ color: "#6b7280" }}>(≈ €{perHourEur})</span> per started hour until {info.checkInTime} — paid on your phone, and your door code starts working immediately.</p>
            )}
            <p style={{ marginTop: 10 }}>Your door code stays the same. We just open it earlier.</p>
          </div>
          <p style={{ marginTop: 22 }}>Type the door code from your SMS or email to see your price:</p>
          <form className="gik-lookup" onSubmit={handleEcLookup}>
            <div>
              <label htmlFor="gik-ec-code">Door code</label>
              <input
                id="gik-ec-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                autoComplete="off"
                value={ecCode}
                onChange={(e) => { setEcCode(e.target.value.replace(/\D/g, "")); setEcError(null); }}
                placeholder="e.g. 4721"
                disabled={ecLoading}
              />
            </div>
            <button type="submit" disabled={ecLoading}>
              {ecLoading ? "Checking…" : "Check price & availability"}
            </button>
          </form>
          {ecError && <div className="gik-err">{ecError}</div>}
          <button
            type="button"
            className="gik-linkbtn"
            onClick={() => { resetEarlyCheckin(); resetLookup(); setPanel("doorcode"); }}
            data-testid="ec-find-code-link"
          >
            Can't find your door code? Tap here to look it up
          </button>
        </>
      );
    }
    if (id === "contact") {
      return (
        <>
          {info.contactPhone && (
            <div className="gik-bigrow" style={{ marginTop: 0 }}>
              <div className="gik-bigbox">
                <div className="k">Call or text us</div>
                <div className="v">{info.contactPhone}</div>
              </div>
            </div>
          )}
          {info.sections.contact && renderInfoText(info.sections.contact)}
        </>
      );
    }
    if (id === "latecheckout") {
      const lc = info.lateCheckout;
      if (!lc) return null;
      const perHourEur = Math.round(lc.pricePerHour / lc.eurRate);

      if (lcPaid) {
        return (
          <div className="gik-result">
            <div className="hi">All set{lcQuote?.firstName ? `, ${capitalizeName(lcQuote.firstName)}` : ""}! ✅</div>
            {receipt ? renderReceiptCard() : (
              <div className="gik-auto">
                <div className="ttl">Late check-out confirmed — your code now works until {lcPayment?.label}</div>
                <p>Your door code is <b>unchanged</b> — same code, just valid longer. Enjoy the extra time!</p>
              </div>
            )}
            <div className="gik-countdown">This screen closes automatically.</div>
          </div>
        );
      }

      if (lcPayment) {
        return (
          <div className="gik-result">
            <div className="hi">Scan to pay {lcPayment.dkk} kr <span style={{ color: "#6b7280", fontWeight: 400 }}>(≈ €{lcPayment.eur})</span></div>
            {lcExpired ? (
              <div className="gik-notice">
                <div className="ttl">Payment window expired</div>
                <div className="sub">No money was taken. Go back and try again.</div>
              </div>
            ) : (
              <>
                <div className="gik-qrwrap">
                  <div className="gik-qr">
                    <QRCodeSVG value={lcPayment.paymentUrl} size={240} level="M" />
                  </div>
                  <p className="gik-qrhint">Scan with your phone camera and pay on the secure payment page</p>
                </div>
                <form className="gik-lookup gik-payopen" onSubmit={(e) => { e.preventDefault(); window.open(lcPayment.paymentUrl, "_blank", "noopener"); }}>
                  <button type="submit">Pay on this phone (card form)</button>
                </form>
                <div className="gik-usednote">This screen updates automatically as soon as your payment is confirmed.</div>
              </>
            )}
          </div>
        );
      }

      if (lcQuote) {
        return (
          <div className="gik-result">
            <div className="hi">Hi {capitalizeName(lcQuote.firstName || "")}!</div>
            <div className="gik-auto">
              <div className="ttl">How long would you like to stay?</div>
              <p>Your door code stays <b>exactly the same</b> — it just keeps working past {info.checkOutTime}.</p>
            </div>
            <form className="gik-lookup" onSubmit={(e) => e.preventDefault()}>
              {lcQuote.options.map((o) => (
                <button key={o.until} type="button" disabled={lcLoading} onClick={() => handleLcPay(o)}>
                  {lcLoading ? "Preparing…" : `Until ${o.label} — ${o.dkk} kr (≈ €${o.eur})`}
                </button>
              ))}
            </form>
            {lcError && <div className="gik-err">{lcError}</div>}
          </div>
        );
      }

      return (
        <>
          <div className="gik-auto">
            <div className="ttl">Need more time on your departure day?</div>
            <p>Stay past {info.checkOutTime} for <b>{lc.pricePerHour} kr</b> <span style={{ color: "#6b7280" }}>(≈ €{perHourEur})</span> per started hour — paid on your phone, and your door code simply keeps working. Buy before {info.checkOutTime}.</p>
          </div>
          <p style={{ marginTop: 22 }}>Type the door code from your SMS or email to see your options:</p>
          <form className="gik-lookup" onSubmit={handleLcLookup}>
            <div>
              <label htmlFor="gik-lc-code">Door code</label>
              <input
                id="gik-lc-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={8}
                autoComplete="off"
                value={lcCode}
                onChange={(e) => { setLcCode(e.target.value.replace(/\D/g, "")); setLcError(null); }}
                placeholder="e.g. 4721"
                disabled={lcLoading}
              />
            </div>
            <button type="submit" disabled={lcLoading}>
              {lcLoading ? "Checking…" : "Show my options"}
            </button>
          </form>
          {lcError && <div className="gik-err">{lcError}</div>}
        </>
      );
    }
    const text = info.sections[id];
    return text ? <>{renderInfoText(text)}</> : null;
  };

  return (
    <div className="gik-root" style={guestThemeStyle(theme)}>
      <style>{KIOSK_CSS}</style>
      <div className="gik-app">
        <div className="gik-card">
          <div className="gik-head">
            <div className="row">
              <div className="gik-logo">
                {theme?.logoUrl && <img src={theme.logoUrl} alt="" />}
                <div>
                  {brandName && <h1>{brandName}</h1>}
                  <p>Guest information</p>
                </div>
              </div>
              <div className="gik-mark">{Icons.info}</div>
            </div>
          </div>
          <div className="gik-grid">
            {tiles.filter((t) => t.show).map((t) => (
              <button
                key={t.id}
                className={`gik-tile${t.hero ? " hero" : ""}`}
                data-testid={`tile-${t.id}`}
                onClick={() => (t.href ? (window.location.href = t.href) : setPanel(t.id as PanelId))}
              >
                <span className="ico">{t.icon}</span>
                <span className="meta">
                  <span className="t" style={{ display: "block" }}>{t.title}</span>
                  <span className="s" style={{ display: "block" }}>{t.sub}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="gik-foot">Secured by DreamBoks</div>
      </div>

      {panel && (
        <div className="gik-panel">
          <div className="inner">
            <button className="gik-back" onClick={goHome}>
              {Icons.back} Back
            </button>
            <div className="gik-card">
              <div className="gik-body">
                <h2>{panelTitle(panel)?.icon} {panelTitle(panel)?.title}</h2>
                {renderPanelBody(panel)}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
