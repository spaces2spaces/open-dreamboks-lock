import { useState, useEffect, useMemo } from "react";
import { useFavicon } from "@/lib/guest-theme";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { useSearch, useLocation } from "wouter";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface LockData {
  id: string;
  ttlockId: string;
  name: string;
  lockType: string;
  doorName?: string | null;
  connectedRoomsCount?: number;
}

interface TenantTheme {
  mode?: string | null;
  brand?: string | null;
  name?: string | null;
  tagline?: string | null;
  logoUrl?: string | null;
  font?: string | null;
  showName?: boolean | null;
  openedBg?: string | null;
}

interface BoardingPassData {
  reservation: {
    id: string;
    firstName: string;
    lastName: string;
    reservationNumber: string;
    room: string | null;
    bed: string | null;
    assignedSpace: string | null;
    roomLabel: string | null;
    arrival: string;
    departure: string;
    status: string;
  };
  pin: {
    code: string;
    validFrom: string;
    validTo: string;
    status: string;
  } | null;
  locks: LockData[];
  checkInMethod: "door_unlock";
  checkInTime?: string;
  checkoutTime?: string;
  paymentRequired?: boolean;
  owing?: string | null;
  currency?: string;
  theme?: TenantTheme | null;
  pinRequiresCheckin?: boolean;
}

// ---- Theme helpers -------------------------------------------------------
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  const h = m ? m[1] : "cc352a";
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
function darkenHex(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * (1 - amount))));
  const to = (c: number) => f(c).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}
function rgba(hex: string, a: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ---- Scoped stylesheet (ported from the multi-tenant design) -------------
const DLK_CSS = `
.dlk-root{--bg:#eef1f6;--surface:#fff;--ink:#1a1d23;--muted:#6b7280;--faint:#9aa1ad;--line:#e7e9ef;--line-strong:#d7dae2;--green:#16a34a;--green-tint:#e6f6ec;--brand-chip-text:var(--brand-dark);
  font-family:var(--dlk-font,"Plus Jakarta Sans",system-ui,-apple-system,sans-serif);min-height:100vh;background:var(--bg);color:var(--ink);
  display:flex;justify-content:center;align-items:flex-start;padding:24px 16px 80px;}
.dlk-root *{box-sizing:border-box;}
.dlk-root.dark{--bg:#0a0c0b;--surface:#15191a;--ink:#f1f4f3;--muted:#9aa3a1;--faint:#69716f;--line:rgba(255,255,255,.09);--line-strong:rgba(255,255,255,.17);--green-tint:rgba(22,163,74,.14);--brand-chip-text:var(--brand);
  background:radial-gradient(120% 70% at 50% -5%, ${"rgba(69,168,136,.10)"}, transparent 55%),#0a0c0b;}
.dlk-app{width:100%;max-width:420px;}
.dlk-card{background:var(--surface);border-radius:26px;overflow:hidden;box-shadow:0 26px 60px -28px rgba(20,24,40,.4),0 1px 0 rgba(255,255,255,.6);}
.dlk-root.dark .dlk-card{box-shadow:0 30px 70px -30px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.05);}
.dlk-reveal{opacity:0;transform:translateY(12px);animation:dlk-rise .6s cubic-bezier(.2,.7,.2,1) forwards;}
@keyframes dlk-rise{to{opacity:1;transform:none;}}
.dlk-head{position:relative;background:linear-gradient(135deg,var(--brand),var(--brand-dark));color:#fff;padding:22px 22px 24px;}
.dlk-root.dark .dlk-head{background:#0f1413;border-bottom:1px solid var(--line);}
.dlk-head::after{content:"";position:absolute;inset:0;background:radial-gradient(80% 120% at 90% -20%,rgba(255,255,255,.22),transparent 55%);}
.dlk-root.dark .dlk-head::after{display:none;}
.dlk-head .row{position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;}
.dlk-logo{display:flex;flex-direction:row;align-items:center;gap:12px;min-width:0;}
.dlk-brandtext{display:flex;flex-direction:column;min-width:0;}
.dlk-logochip{display:inline-flex;background:transparent;border-radius:11px;padding:0;}
.dlk-root.dark .dlk-logochip{background:transparent;box-shadow:none;padding:0;}
.dlk-logochip img{height:52px;width:auto;display:block;}
.dlk-root.dark .dlk-logochip img{height:46px;}
.dlk-logo h1{font-weight:800;font-size:20px;letter-spacing:-.3px;line-height:1.05;}
.dlk-logo p{font-size:12.5px;color:rgba(255,255,255,.9);margin-top:3px;}
.dlk-keymark{width:44px;height:44px;flex-shrink:0;border-radius:13px;display:grid;place-items:center;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.28);}
.dlk-keymark svg{width:22px;height:22px;}
.dlk-guest{display:flex;align-items:center;gap:14px;padding:18px 22px 6px;}
.dlk-avatar{width:46px;height:46px;border-radius:50%;background:var(--brand-tint);color:var(--brand);display:grid;place-items:center;flex-shrink:0;border:1px solid var(--line);}
.dlk-avatar svg{width:24px;height:24px;}
.dlk-guest .info{flex:1;min-width:0;}
.dlk-guest .info .k{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:var(--faint);font-weight:700;}
.dlk-guest .info .name{font-weight:800;font-size:20px;line-height:1.1;margin-top:1px;}
.dlk-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;padding:6px 11px;border-radius:999px;background:var(--brand-tint);color:var(--brand-chip-text);white-space:nowrap;}
.dlk-pill .dot{width:7px;height:7px;border-radius:50%;background:var(--brand);}
.dlk-pill.ok{background:var(--green-tint);color:var(--green);}
.dlk-pill.ok .dot{background:var(--green);}
.dlk-roomstrip{display:flex;align-items:center;gap:8px;padding:8px 22px 18px;color:var(--muted);font-size:14px;border-bottom:1px solid var(--line);}
.dlk-roomstrip svg{width:17px;height:17px;color:var(--brand);}
.dlk-roomstrip b{color:var(--ink);font-weight:800;font-size:16px;}
.dlk-instr{display:flex;align-items:center;gap:9px;padding:18px 22px 4px;}
.dlk-instr .badge{width:22px;height:22px;border-radius:7px;background:var(--brand);color:#fff;display:grid;place-items:center;}
.dlk-instr .badge svg{width:13px;height:13px;}
.dlk-instr h2{font-size:13px;font-weight:800;letter-spacing:.2px;text-transform:uppercase;color:var(--ink);}
.dlk-keys{display:flex;flex-direction:column;gap:12px;padding:12px 18px 6px;}
.dlk-ubtn{-webkit-appearance:none;appearance:none;font:inherit;text-align:left;width:100%;display:flex;align-items:center;gap:14px;cursor:pointer;color:var(--ink);background:var(--surface);border:2px solid var(--line-strong);border-radius:16px;padding:13px 13px 13px 14px;box-shadow:0 4px 0 var(--line-strong);transition:transform .12s ease,box-shadow .12s ease,border-color .25s,background .25s;}
.dlk-ubtn:hover{border-color:var(--brand);}
.dlk-ubtn:active{transform:translateY(4px);box-shadow:0 0 0 var(--line-strong);}
.dlk-root.dark .dlk-ubtn{background:linear-gradient(180deg,${"rgba(69,168,136,.12)"},${"rgba(69,168,136,.04)"});border-color:${"rgba(69,168,136,.5)"};box-shadow:0 4px 0 ${"rgba(69,168,136,.22)"};}
.dlk-ubtn .lockwrap{width:48px;height:48px;flex-shrink:0;border-radius:13px;display:grid;place-items:center;background:var(--brand-tint);transition:background .3s;}
.dlk-ubtn .lockwrap svg{width:25px;height:25px;stroke:var(--brand);}
.dlk-ubtn .meta{flex:1;min-width:0;}
.dlk-ubtn .meta .t{font-weight:800;font-size:17px;line-height:1.15;}
.dlk-ubtn .tag{display:inline-flex;align-items:center;margin-top:6px;font-size:11px;font-weight:800;letter-spacing:.3px;padding:3px 9px;border-radius:7px;text-transform:uppercase;}
.dlk-ubtn .tag.common{background:#eef0f4;color:#6b7280;}
.dlk-root.dark .dlk-ubtn .tag.common{background:rgba(255,255,255,.07);color:var(--muted);}
.dlk-ubtn .tag.room{background:var(--brand-tint);color:var(--brand-chip-text);}
.dlk-ubtn .cta{flex-shrink:0;display:inline-flex;align-items:center;gap:7px;background:var(--brand);color:#fff;font-weight:800;font-size:14px;padding:11px 15px;border-radius:11px;transition:background .25s;box-shadow:0 4px 12px -4px var(--brand);}
.dlk-ubtn .cta svg{width:16px;height:16px;}
.dlk-ubtn .cta .spin{width:16px;height:16px;border:2.5px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:dlk-spin .7s linear infinite;}
@keyframes dlk-spin{to{transform:rotate(360deg);}}
.dlk-ubtn.done{border-color:var(--green);background:var(--opened-bg,var(--green-tint));box-shadow:0 4px 0 ${"rgba(22,163,74,.3)"};}
.dlk-ubtn.done .lockwrap{background:${"rgba(22,163,74,.2)"};}
.dlk-ubtn.done .lockwrap svg{stroke:var(--green);}
.dlk-ubtn.done .cta{background:var(--green);box-shadow:0 4px 12px -4px var(--green);}
.dlk-ubtn:disabled{cursor:default;}
.dlk-block{margin:18px;}
.dlk-block.tight{margin-top:0;}
.dlk-pinwrap{background:var(--bg);border:1px solid var(--line);border-radius:14px;overflow:hidden;}
.dlk-pinwrap .toggle{width:100%;-webkit-appearance:none;appearance:none;font:inherit;cursor:pointer;display:flex;align-items:center;gap:9px;background:none;border:none;color:var(--muted);padding:13px 16px;text-align:left;}
.dlk-pinwrap .toggle .ico{width:17px;height:17px;flex-shrink:0;color:var(--faint);}
.dlk-pinwrap .toggle .lab{flex:1;font-size:13px;font-weight:600;}
.dlk-pinwrap .toggle .lab small{display:block;font-weight:500;font-size:11.5px;color:var(--faint);margin-top:1px;}
.dlk-pinwrap .toggle .chev{width:16px;height:16px;color:var(--faint);transition:transform .25s;}
.dlk-pinwrap.open .toggle .chev{transform:rotate(180deg);}
.dlk-pinwrap .body{max-height:0;opacity:0;overflow:hidden;transition:max-height .3s ease,opacity .25s ease;}
.dlk-pinwrap.open .body{max-height:200px;opacity:1;}
.dlk-pinwrap .inner{padding:2px 16px 14px;text-align:center;}
.dlk-digits{display:flex;justify-content:center;gap:7px;margin:6px 0 8px;}
.dlk-digits .d{font-family:"DM Mono",ui-monospace,monospace;font-size:18px;color:var(--ink);width:30px;height:36px;display:grid;place-items:center;border-radius:8px;background:var(--surface);border:1px solid var(--line-strong);}
.dlk-valid{font-size:11.5px;color:var(--faint);}
.dlk-valid b{color:var(--muted);font-weight:600;}
.dlk-copy{margin-top:8px;font-size:11px;color:var(--faint);display:inline-flex;align-items:center;gap:6px;font-weight:600;cursor:pointer;background:none;border:none;}
.dlk-copy svg{width:12px;height:12px;}
.dlk-copy.copied{color:var(--green);}
.dlk-stay{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;border:1px solid var(--line);border-radius:20px;padding:16px 18px;}
.dlk-stay .col .k{font-size:11px;text-transform:uppercase;letter-spacing:1.2px;color:var(--faint);font-weight:800;display:flex;align-items:center;gap:6px;}
.dlk-stay .col .k svg{width:13px;height:13px;color:var(--brand);}
.dlk-stay .col.out{text-align:right;}
.dlk-stay .col.out .k{justify-content:flex-end;}
.dlk-stay .col .v{font-weight:800;font-size:16px;margin-top:6px;}
.dlk-stay .col .time{font-size:13px;color:var(--muted);margin-top:1px;}
.dlk-stay .mid{display:flex;flex-direction:column;align-items:center;gap:5px;padding:0 10px;}
.dlk-stay .mid .nights{font-size:10.5px;font-weight:800;color:var(--faint);}
.dlk-stay .mid .line{width:42px;height:2px;background:linear-gradient(90deg,var(--green),var(--brand));border-radius:2px;}
.dlk-res{display:flex;align-items:center;justify-content:space-between;border:1px solid var(--line);border-radius:16px;padding:13px 18px;}
.dlk-res .k{font-size:13px;color:var(--muted);}
.dlk-res .cd{font-size:11.5px;color:var(--faint);margin-top:2px;}
.dlk-res .cd b{color:var(--brand);font-weight:700;}
.dlk-res .v{font-family:"DM Mono",ui-monospace,monospace;font-size:18px;letter-spacing:1px;}
.dlk-email{border:1px solid var(--line);border-radius:16px;padding:15px 16px;}
.dlk-email .lab{font-size:13px;color:var(--muted);display:flex;align-items:center;gap:7px;margin-bottom:10px;font-weight:600;}
.dlk-email .lab svg{width:15px;height:15px;color:var(--brand);}
.dlk-email .field{display:flex;gap:9px;}
.dlk-email input{flex:1;min-width:0;background:var(--bg);border:1.5px solid var(--line-strong);border-radius:12px;color:var(--ink);font:inherit;font-size:14.5px;padding:13px 14px;outline:none;transition:border-color .2s;}
.dlk-email input::placeholder{color:var(--faint);}
.dlk-email input:focus{border-color:var(--brand);}
.dlk-email button{flex-shrink:0;display:inline-flex;align-items:center;gap:7px;border:none;border-radius:12px;cursor:pointer;color:#fff;background:var(--brand);font:inherit;font-weight:800;font-size:14px;padding:0 16px;}
.dlk-email button:disabled{opacity:.55;cursor:default;}
.dlk-email button svg{width:17px;height:17px;}
.dlk-foot{text-align:center;font-size:11px;color:var(--faint);padding:6px 0 14px;font-weight:600;letter-spacing:.3px;}
.dlk-notice{margin:18px;border-radius:16px;padding:20px;text-align:center;}
.dlk-notice .ttl{font-weight:800;font-size:16px;margin-top:8px;}
.dlk-notice .sub{font-size:13px;color:var(--muted);margin-top:6px;}
.dlk-notice.warn{background:${"rgba(245,158,11,.10)"};border:1px solid ${"rgba(245,158,11,.4)"};}
.dlk-notice.warn .ttl{color:#b45309;}
.dlk-notice.err{background:${"rgba(229,62,62,.08)"};border:1px solid ${"rgba(229,62,62,.4)"};}
.dlk-notice.err .ttl{color:#dc2626;}
.dlk-notice .amount{font-family:"DM Mono",ui-monospace,monospace;font-size:26px;font-weight:800;color:var(--ink);margin:10px 0;}
.dlk-notice .paybtn{margin-top:6px;width:100%;border:none;border-radius:12px;background:var(--brand);color:#fff;font:inherit;font-weight:800;font-size:15px;padding:13px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;}
.dlk-notice .paybtn:disabled{opacity:.6;cursor:default;}
.dlk-lookup{padding:26px 22px 28px;}
.dlk-lookup .mark{width:60px;height:60px;border-radius:18px;margin:0 auto 16px;display:grid;place-items:center;background:linear-gradient(135deg,var(--brand),var(--brand-dark));color:#fff;}
.dlk-lookup .mark svg{width:30px;height:30px;}
.dlk-lookup h1{text-align:center;font-size:22px;font-weight:800;color:var(--ink);}
.dlk-lookup p{text-align:center;font-size:13.5px;color:var(--muted);margin-top:5px;}
.dlk-lookup form{margin-top:20px;display:flex;flex-direction:column;gap:14px;}
.dlk-lookup label{font-size:12px;font-weight:700;color:var(--muted);display:block;margin-bottom:6px;}
.dlk-lookup input{width:100%;background:var(--bg);border:1.5px solid var(--line-strong);border-radius:12px;color:var(--ink);font:inherit;font-size:16px;padding:14px;outline:none;transition:border-color .2s;}
.dlk-lookup input:focus{border-color:var(--brand);}
.dlk-lookup button{width:100%;border:none;border-radius:13px;background:var(--brand);color:#fff;font:inherit;font-weight:800;font-size:16px;padding:15px;cursor:pointer;margin-top:4px;}
.dlk-lookup button:disabled{opacity:.6;cursor:default;}
.dlk-loading{padding:60px 22px 56px;display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center;}
.dlk-loading .mark{width:64px;height:64px;border-radius:18px;display:grid;place-items:center;background:linear-gradient(135deg,var(--brand),var(--brand-dark));color:#fff;overflow:hidden;}
.dlk-loading .mark svg{width:32px;height:32px;}
.dlk-loading .mark img{width:100%;height:100%;object-fit:cover;}
.dlk-loading .dlk-spinner{width:30px;height:30px;border:3px solid var(--brand-tint);border-top-color:var(--brand);border-radius:50%;animation:dlk-spin .7s linear infinite;}
.dlk-loading p{font-size:14px;color:var(--muted);font-weight:600;}
.dlk-banner{position:fixed;bottom:0;left:0;right:0;background:#15191a;color:#fff;padding:14px 16px;z-index:50;box-shadow:0 -10px 30px -10px rgba(0,0,0,.5);}
.dlk-banner .inner{max-width:420px;margin:0 auto;display:flex;align-items:center;gap:12px;}
.dlk-banner .ic{flex-shrink:0;width:40px;height:40px;border-radius:10px;background:var(--brand);display:grid;place-items:center;}
.dlk-banner .ic svg{width:20px;height:20px;}
.dlk-banner .tx{flex:1;min-width:0;}
.dlk-banner .tx .t{font-weight:700;font-size:13px;}
.dlk-banner .tx .s{font-size:11.5px;color:#cbd2d0;margin-top:1px;}
.dlk-banner .act{flex-shrink:0;border:none;border-radius:9px;background:var(--brand);color:#fff;font:inherit;font-weight:700;font-size:13px;padding:8px 12px;cursor:pointer;}
.dlk-banner .x{flex-shrink:0;background:none;border:none;color:#fff;cursor:pointer;padding:4px;opacity:.7;}
.dlk-banner .x svg{width:18px;height:18px;}
`;

// ---- Inline icons (match design) -----------------------------------------
const Svg = (p: { d?: string; children?: React.ReactNode; sw?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={p.sw ?? 2} strokeLinecap="round" strokeLinejoin="round">
    {p.d ? <path d={p.d} /> : p.children}
  </svg>
);

export default function BoardingPassEkeyPage() {
  const { toast } = useToast();
  const searchString = useSearch();
  const [, setLocation] = useLocation();
  const [reservationNumber, setReservationNumber] = useState("");
  const [lastName, setLastName] = useState("");
  // Start in the loading state when an auto-lookup is about to fire (URL params or
  // stored PWA credentials present), so the guest never sees the lookup FORM flash
  // before their card — they go straight to a branded loading screen, then the card.
  const [loading, setLoading] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("res") && params.get("name")) return true;
      const res = localStorage.getItem("dreamlock-reservation") || sessionStorage.getItem("dreamlock-reservation");
      const name = localStorage.getItem("dreamlock-lastname") || sessionStorage.getItem("dreamlock-lastname");
      return !!(res && name);
    } catch {
      return false;
    }
  });
  const [boardingPass, setBoardingPass] = useState<BoardingPassData | null>(null);
  const [autoLookupAttempted, setAutoLookupAttempted] = useState(false);
  const [unlockingLocks, setUnlockingLocks] = useState<Set<string>>(new Set());
  const [unlockSuccess, setUnlockSuccess] = useState<Set<string>>(new Set());
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [emailToSend, setEmailToSend] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);
  const [sendingPaymentLink, setSendingPaymentLink] = useState(false);
  const [paymentLinkSent, setPaymentLinkSent] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Tenant theme fetched from the slug BEFORE the boarding-pass lookup resolves,
  // so the auto-lookup / loading screen shown before the card already carries the
  // hotel's branding (green Capsule design) instead of flashing the default red.
  const [prefetchedTheme, setPrefetchedTheme] = useState<TenantTheme | null>(null);

  // Hotel slug for multi-tenant guests on the unscoped /boarding-pass page:
  // from ?hotel=<slug>, falling back to a previously persisted value (PWA relaunch).
  // Forwarded to the public API so non-default tenants resolve to the right hotel.
  const hotelSlug = useMemo(() => {
    const fromUrl = new URLSearchParams(searchString).get("hotel");
    if (fromUrl) return fromUrl;
    try { return localStorage.getItem("dreamlock-hotel") || ""; } catch { return ""; }
  }, [searchString]);
  // Note: the slug is persisted only on a SUCCESSFUL lookup (saveCredentials) and
  // cleared on an invalid stored lookup (clearCredentials) — so a wrong/stale slug
  // never sticks and mis-routes a later lookup to the wrong tenant.

  // Pre-fetch the tenant theme from the slug so the pre-card (lookup/auto-advance)
  // screen is branded immediately. The boarding-pass response still carries the
  // authoritative theme; this only fills the gap before that arrives.
  useEffect(() => {
    if (!hotelSlug || boardingPass) return;
    let cancelled = false;
    fetch(`/api/public/hotel-info/${encodeURIComponent(hotelSlug)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.theme) setPrefetchedTheme(data.theme as TenantTheme);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [hotelSlug, boardingPass]);

  // Load the per-tenant web font from Google Fonts when the theme specifies one.
  // Injected lazily (only for tenants that set boarding_font) so other tenants pay nothing.
  const themeFont = boardingPass?.theme?.font || prefetchedTheme?.font || null;
  useEffect(() => {
    if (!themeFont) return;
    const id = `gfont-${themeFont.replace(/[^a-z0-9]+/gi, "-")}`;
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(themeFont).replace(/%20/g, "+")}:wght@400;600;700;800&display=swap`;
    document.head.appendChild(link);
  }, [themeFont]);

  // Sort locks: Common doors first (sorted by connectedRoomsCount desc), then room lock by numeric name
  const sortedLocks = useMemo(() => {
    if (!boardingPass?.locks) return [];

    const extractNumber = (name: string): number => {
      const match = name.match(/(\d+\.?\d*)/);
      return match ? parseFloat(match[1]) : Infinity;
    };

    return [...boardingPass.locks].sort((a, b) => {
      const aIsCommon = a.lockType !== "room";
      const bIsCommon = b.lockType !== "room";

      // Common doors always before room locks
      if (aIsCommon !== bIsCommon) return aIsCommon ? -1 : 1;

      // Among common doors: most-connected first (main entrance > floor door > etc.)
      if (aIsCommon && bIsCommon) {
        const aCount = a.connectedRoomsCount ?? 0;
        const bCount = b.connectedRoomsCount ?? 0;
        if (bCount !== aCount) return bCount - aCount;
      }

      // Fall back to numeric name sort
      const aNum = extractNumber(a.name);
      const bNum = extractNumber(b.name);
      if (aNum !== bNum) return aNum - bNum;

      return a.name.localeCompare(b.name);
    });
  }, [boardingPass?.locks]);

  useEffect(() => {
    document.title = "DreamBoks Key";

    // Check if iOS
    const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent);
    setIsIOS(isIOSDevice);

    // Check if already installed as PWA
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
    if (isStandalone) {
      return; // Already installed, don't show banner
    }

    // For iOS, show manual install instructions
    if (isIOSDevice) {
      const dismissed = localStorage.getItem('pwa-install-dismissed');
      if (!dismissed) {
        setShowInstallBanner(true);
      }
      return;
    }

    // For Android/Chrome, listen for install prompt
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      const dismissed = localStorage.getItem('pwa-install-dismissed');
      if (!dismissed) {
        setShowInstallBanner(true);
      }
    };

    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  useEffect(() => {
    if (boardingPass) {
      const departureDate = new Date(boardingPass.reservation.departure);
      const now = new Date();
      if (now > departureDate) {
        setLocation(hotelSlug ? `/rate?hotel=${encodeURIComponent(hotelSlug)}` : "/rate");
      }
    }
  }, [boardingPass, setLocation]);

  // Helper to safely get stored credentials (try localStorage, then sessionStorage)
  const getStoredCredentials = (): { res: string | null; name: string | null } => {
    try {
      let res = localStorage.getItem('dreamlock-reservation');
      let name = localStorage.getItem('dreamlock-lastname');
      if (res && name) return { res, name };

      // Fallback to sessionStorage
      res = sessionStorage.getItem('dreamlock-reservation');
      name = sessionStorage.getItem('dreamlock-lastname');
      return { res, name };
    } catch {
      return { res: null, name: null };
    }
  };

  // Helper to safely save credentials to both storage types
  const saveCredentials = (res: string, name: string) => {
    try {
      localStorage.setItem('dreamlock-reservation', res);
      localStorage.setItem('dreamlock-lastname', name);
      sessionStorage.setItem('dreamlock-reservation', res);
      sessionStorage.setItem('dreamlock-lastname', name);
      // Persist the tenant slug only alongside a confirmed-good lookup.
      if (hotelSlug) localStorage.setItem('dreamlock-hotel', hotelSlug);
    } catch {
      // Storage not available
    }
  };

  // Helper to clear stored credentials
  const clearCredentials = () => {
    try {
      localStorage.removeItem('dreamlock-reservation');
      localStorage.removeItem('dreamlock-lastname');
      sessionStorage.removeItem('dreamlock-reservation');
      sessionStorage.removeItem('dreamlock-lastname');
      localStorage.removeItem('dreamlock-hotel');
    } catch {
      // Storage not available
    }
  };

  // Auto-lookup from URL params or storage (for PWA homescreen)
  useEffect(() => {
    if (autoLookupAttempted) return;

    const params = new URLSearchParams(searchString);
    let resParam = params.get("res");
    let nameParam = params.get("name");

    // If no URL params, try stored credentials (for PWA homescreen launch)
    if (!resParam || !nameParam) {
      const stored = getStoredCredentials();
      if (stored.res && stored.name) {
        resParam = stored.res;
        nameParam = stored.name;
      }
    }

    if (resParam && nameParam) {
      setReservationNumber(resParam);
      setLastName(nameParam);
      setAutoLookupAttempted(true);

      setLoading(true);
      fetch("/api/public/boarding-pass-ekey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationNumber: resParam, lastName: nameParam, hotelSlug }),
      })
        .then(async (response) => {
          if (!response.ok) {
            const error = await response.json();
            // Clear invalid stored credentials
            clearCredentials();
            toast({
              title: "Reservation not found",
              description: error.error || "Please check your reservation number and last name",
              variant: "destructive",
            });
            return;
          }
          const data = await response.json();
          // Save valid credentials for PWA homescreen
          saveCredentials(resParam!, nameParam!);
          setBoardingPass(data);
          // Background sync: refresh from MEWS without blocking UI
          runBackgroundSync(resParam!, nameParam!);
        })
        .catch(() => {
          toast({
            title: "Error",
            description: "Failed to retrieve digital key. Please try again.",
            variant: "destructive",
          });
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [searchString, autoLookupAttempted, toast]);

  const handleLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setBoardingPass(null);

    try {
      const response = await fetch("/api/public/boarding-pass-ekey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationNumber, lastName, hotelSlug }),
      });

      if (!response.ok) {
        const error = await response.json();
        toast({
          title: "Reservation not found",
          description: error.error || "Please check your reservation number and last name",
          variant: "destructive",
        });
        return;
      }

      const data = await response.json();
      // Save credentials for PWA homescreen
      saveCredentials(reservationNumber, lastName);
      setBoardingPass(data);
      // Background sync: refresh from MEWS without blocking UI
      runBackgroundSync(reservationNumber, lastName);
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to retrieve digital key. Please try again.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const handleUnlock = async (lock: LockData) => {
    if (unlockingLocks.has(lock.id)) return;

    setUnlockingLocks(prev => new Set(prev).add(lock.id));
    let succeeded = false;

    const doUnlock = async (attempt: number): Promise<boolean> => {
      const controller = new AbortController();
      let timedOut = false;
      // TTLock remote unlock via the gateway (BLE handshake) routinely takes 15-25s.
      // Give it 30s so a successful unlock isn't reported as a failure prematurely.
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30000);
      try {
        const response = await fetch("/api/public/unlock", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // The door code is sent along: a typed booking number alone is not enough to unlock remotely.
          body: JSON.stringify({ reservationNumber, lastName, lockId: lock.id, hotelSlug, pin: boardingPass?.pin?.code }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        const data = await response.json();
        if (!response.ok) {
          if (attempt < 2) return false;
          toast({ title: "Unlock Failed", description: data.error || "Failed to unlock door", variant: "destructive" });
          return true;
        }
        setUnlockSuccess(prev => new Set(prev).add(lock.id));
        succeeded = true;
        toast({ title: "Door Unlocked", description: `${lock.name} has been unlocked successfully` });
        setTimeout(() => { setUnlockSuccess(prev => { const next = new Set(prev); next.delete(lock.id); return next; }); }, 3000);
        return true;
      } catch {
        clearTimeout(timeout);
        // On a client-side timeout the server is almost certainly still completing the
        // unlock — do NOT fire a second request (it would double-command the lock).
        if (timedOut) {
          toast({ title: "Taking a little longer", description: "The door should open shortly. If it doesn't, enter your PIN code.", variant: "destructive" });
          return true;
        }
        if (attempt < 2) return false;
        toast({ title: "Error", description: "Failed to unlock door. Please try again.", variant: "destructive" });
        return true;
      }
    };

    try {
      if (!await doUnlock(1)) await doUnlock(2);
    } finally {
      setUnlockingLocks(prev => { const next = new Set(prev); next.delete(lock.id); return next; });
    }

    // If the PIN is gated behind check-in, the unlock just checked the guest in
    // (server-side). Poll the boarding pass until checked-in so the PIN reveals.
    if (succeeded && pinRequiresCheckin && !isCheckedIn) {
      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          const resp = await fetch("/api/public/boarding-pass-ekey", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reservationNumber, lastName, hotelSlug }),
          });
          if (!resp.ok) continue;
          const data: BoardingPassData = await resp.json();
          setBoardingPass(prev => (prev ? { ...data, theme: data.theme ?? prev.theme } : data));
          if (["checked-in", "started"].includes((data.reservation.status || "").toLowerCase())) break;
        } catch {
          // retry
        }
      }
    }
  };

  // Background MEWS sync — runs after boarding card is rendered with cached data
  // Only updates UI if status, PIN, locks, or payment actually changed
  const runBackgroundSync = (resNum: string, lName: string) => {
    setSyncing(true);
    fetch("/api/public/boarding-pass-sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reservationNumber: resNum, lastName: lName, hotelSlug }),
    })
      .then(async (response) => {
        if (!response.ok) return;
        const fresh: BoardingPassData = await response.json();
        setBoardingPass((prev) => {
          if (!prev) return fresh;
          const changed =
            prev.reservation.status !== fresh.reservation.status ||
            prev.reservation.room !== fresh.reservation.room ||
            prev.reservation.arrival !== fresh.reservation.arrival ||
            prev.reservation.departure !== fresh.reservation.departure ||
            prev.pin?.status !== fresh.pin?.status ||
            prev.pin?.code !== fresh.pin?.code ||
            prev.locks.length !== fresh.locks.length ||
            prev.paymentRequired !== fresh.paymentRequired ||
            prev.owing !== fresh.owing;
          // Always keep a theme (fall back to previously loaded one)
          const merged = { ...fresh, theme: fresh.theme ?? prev.theme };
          return changed ? merged : { ...prev, theme: merged.theme };
        });
      })
      .catch(() => {
        // Sync failed silently — cached data remains
      })
      .finally(() => {
        setSyncing(false);
      });
  };

  const getRoomDisplay = () => {
    if (!boardingPass) return "";
    const { room, assignedSpace } = boardingPass.reservation;
    return assignedSpace || room || "Not assigned";
  };

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      try {
        await deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        // Always clear state after prompt - it can only be used once
        setShowInstallBanner(false);
        setDeferredPrompt(null);
        if (outcome === 'dismissed') {
          localStorage.setItem('pwa-install-dismissed', 'true');
        }
      } catch {
        // Prompt already used or unavailable
        setShowInstallBanner(false);
        setDeferredPrompt(null);
      }
    }
  };

  const dismissInstallBanner = () => {
    setShowInstallBanner(false);
    localStorage.setItem('pwa-install-dismissed', 'true');
  };

  const handleSendPaymentLink = async () => {
    if (!boardingPass) return;
    setSendingPaymentLink(true);
    try {
      const response = await fetch("/api/public/boarding-pass/request-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationNumber, lastName, hotelSlug }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create payment");
      }
      const data = await response.json();
      if (data.paymentUrl) {
        window.location.href = data.paymentUrl;
      }
    } catch (error) {
      toast({ title: "Error", description: error instanceof Error ? error.message : "Could not open payment", variant: "destructive" });
    } finally {
      setSendingPaymentLink(false);
    }
  };

  const sendBoardingPassToEmail = async () => {
    if (!emailToSend || !emailToSend.includes("@") || !boardingPass) {
      toast({
        title: "Invalid email",
        description: "Please enter a valid email address",
        variant: "destructive",
      });
      return;
    }

    setSendingEmail(true);
    try {
      const response = await fetch("/api/public/send-boarding-pass-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reservationNumber,
          lastName,
          email: emailToSend,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to send email");
      }

      toast({
        title: "Email sent!",
        description: `Digital key sent to ${emailToSend}`,
      });
      setEmailToSend("");
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Could not send email",
        variant: "destructive",
      });
    } finally {
      setSendingEmail(false);
    }
  };

  const copyPin = async () => {
    if (!boardingPass?.pin) return;
    try {
      await navigator.clipboard.writeText(boardingPass.pin.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  };

  // ---- Theme resolution ----
  const theme: TenantTheme = boardingPass?.theme || prefetchedTheme || {};
  const isDark = theme.mode === "dark";
  const brand = theme.brand || "#cc352a";
  const brandFont = theme.font || null;
  const rootStyle = {
    ["--brand" as string]: brand,
    ["--brand-dark" as string]: darkenHex(brand, 0.14),
    ["--brand-tint" as string]: rgba(brand, 0.14),
    // Per-tenant web font (falls back to the default stack when unset).
    ...(brandFont ? { ["--dlk-font" as string]: `"${brandFont}", "Plus Jakarta Sans", system-ui, sans-serif` } : {}),
    // Per-tenant background for an opened (unlocked) door button.
    ...(theme.openedBg ? { ["--opened-bg" as string]: theme.openedBg } : {}),
  } as React.CSSProperties;
  const brandName = theme.name || "DreamBoks";
  const tagline = theme.tagline || "Tap a button to unlock your doors";
  const logoUrl = theme.logoUrl || null;
  const showName = !!theme.showName;
  useFavicon(logoUrl, theme.brand);

  const status = boardingPass?.reservation.status || "";
  const isCheckedIn = ["checked-in", "started"].includes(status.toLowerCase());
  const pinRequiresCheckin = boardingPass?.pinRequiresCheckin ?? false;
  const isBlocked = status === "Cancelled" || status === "no-show";

  return (
    <div className={`dlk-root${isDark ? " dark" : ""}`} style={rootStyle}>
      <style>{DLK_CSS}</style>
      <div className="dlk-app">
        {!boardingPass ? (
          loading ? (
            // Auto-lookup in progress: show a clean, branded loading screen instead of
            // the lookup form. The guest clicked their personal link (or relaunched the
            // PWA), so the form + auto-filled fields must never be shown to them.
            <div className="dlk-card dlk-reveal">
              <div className="dlk-loading">
                <div className="mark">
                  {logoUrl ? <img src={logoUrl} alt="" /> : (
                    <Svg sw={1.8}><><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3 19 4" /><path d="M16 7l3 3" /><path d="M14 9l2 2" /></></Svg>
                  )}
                </div>
                <div className="dlk-spinner" />
                <p>Loading your digital key…</p>
              </div>
            </div>
          ) : (
          <div className="dlk-card dlk-reveal">
            <div className="dlk-lookup">
              <div className="mark">
                <Svg sw={1.8}><><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3 19 4" /><path d="M16 7l3 3" /><path d="M14 9l2 2" /></></Svg>
              </div>
              <h1>{brandName}</h1>
              <p>Enter your reservation details to unlock your doors</p>
              <form onSubmit={handleLookup}>
                <div>
                  <label htmlFor="reservation-number">Reservation number</label>
                  <input
                    id="reservation-number"
                    type="text"
                    placeholder="e.g. 63816"
                    value={reservationNumber}
                    onChange={(e) => setReservationNumber(e.target.value)}
                    required
                    data-testid="input-reservation-number"
                  />
                </div>
                <div>
                  <label htmlFor="last-name">Last name</label>
                  <input
                    id="last-name"
                    type="text"
                    placeholder="Enter your last name"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    required
                    data-testid="input-last-name"
                  />
                </div>
                <button type="submit" disabled={loading} data-testid="button-lookup">
                  {loading ? "Looking up…" : "Get my key"}
                </button>
              </form>
            </div>
            <div className="dlk-foot">Secured by DreamBoks</div>
          </div>
          )
        ) : (
          <div className="dlk-card dlk-reveal">
            {/* HEADER */}
            <header className="dlk-head">
              <div className="row">
                <div className="dlk-logo">
                  {logoUrl && (
                    <span className="dlk-logochip"><img src={logoUrl} alt={brandName} /></span>
                  )}
                  {(!logoUrl || showName) && (
                    <div className="dlk-brandtext">
                      <h1>{brandName}</h1>
                      <p>{tagline}</p>
                    </div>
                  )}
                </div>
                <div className="dlk-keymark">
                  <Svg sw={2}><><circle cx="7.5" cy="15.5" r="4.5" /><path d="M10.7 12.3 19 4" /><path d="M16 7l3 3" /><path d="M14 9l2 2" /></></Svg>
                </div>
              </div>
            </header>

            {/* GUEST */}
            <div className="dlk-guest">
              <div className="dlk-avatar">
                <Svg><><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.5-7 8-7s8 3 8 7" /></></Svg>
              </div>
              <div className="info">
                <div className="k">Guest</div>
                <div className="name" data-testid="text-guest-name">
                  {boardingPass.reservation.firstName} {boardingPass.reservation.lastName}
                </div>
              </div>
              <div className={`dlk-pill${isCheckedIn ? " ok" : ""}`} data-testid="badge-status">
                <span className="dot" />
                {isCheckedIn ? "Checked in" : status || "Reserved"}
              </div>
            </div>
            <div className="dlk-roomstrip">
              <Svg><><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></></Svg>
              Room <b data-testid="text-room">{getRoomDisplay()}</b>
            </div>

            {/* CANCELLED */}
            {isBlocked && (
              <div className="dlk-notice err">
                <Svg sw={2}><><circle cx="12" cy="12" r="9" /><path d="m15 9-6 6M9 9l6 6" /></></Svg>
                <div className="ttl">Reservation cancelled</div>
                <div className="sub">This reservation has been cancelled. Please contact reception if you believe this is an error.</div>
              </div>
            )}

            {/* PAYMENT REQUIRED */}
            {boardingPass.paymentRequired && !isBlocked && (
              <div className="dlk-notice err">
                <Svg sw={2}><><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></></Svg>
                <div className="ttl">Payment required</div>
                <div className="amount">
                  {parseFloat(boardingPass.owing!).toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {boardingPass.currency || "DKK"}
                </div>
                <div className="sub">Please settle your balance to access your room.</div>
                <button className="paybtn" onClick={handleSendPaymentLink} disabled={sendingPaymentLink}>
                  {sendingPaymentLink ? "Opening payment…" : "Pay now"}
                </button>
              </div>
            )}

            {/* UNLOCK BUTTONS */}
            {sortedLocks.length > 0 && !isBlocked && (
              <>
                <div className="dlk-instr">
                  <span className="badge"><Svg sw={2.5} d="m9 18 6-6-6-6" /></span>
                  <h2>Tap a button to unlock</h2>
                </div>
                <div className="dlk-keys">
                  {sortedLocks.map((lock) => {
                    const isLoading = unlockingLocks.has(lock.id);
                    const isDone = unlockSuccess.has(lock.id);
                    const isRoom = lock.lockType === "room";
                    return (
                      <button
                        key={lock.id}
                        className={`dlk-ubtn${isDone ? " done" : ""}`}
                        onClick={() => handleUnlock(lock)}
                        disabled={isLoading}
                        data-testid={`button-unlock-${lock.id}`}
                      >
                        <span className="lockwrap">
                          {isDone ? (
                            <Svg sw={2.5} d="M20 6 9 17l-5-5" />
                          ) : (
                            <Svg sw={2}><><rect x="4" y="11" width="16" height="10" rx="2.5" /><path d="M8 11V7a4 4 0 0 1 8 0" /></></Svg>
                          )}
                        </span>
                        <span className="meta">
                          <span className="t">{lock.doorName || lock.name}</span>
                          <span className={`tag ${isRoom ? "room" : "common"}`}>{isRoom ? "Room" : "Common"}</span>
                        </span>
                        <span className="cta">
                          {isLoading ? (
                            <span className="spin" />
                          ) : isDone ? (
                            <>Opened</>
                          ) : (
                            <>Unlock <Svg sw={2.5} d="m9 18 6-6-6-6" /></>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {pinRequiresCheckin && !isCheckedIn && (
                  <div style={{ padding: "2px 20px 10px", textAlign: "center", fontSize: 13, color: "var(--muted)" }}>
                    Press a button to unlock — your PIN code appears once you're checked in.
                  </div>
                )}
              </>
            )}

            {/* NO ACCESS CONFIGURED */}
            {boardingPass.locks.length === 0 && !boardingPass.pin && !boardingPass.paymentRequired && !isBlocked && (
              <div className="dlk-notice warn">
                <Svg sw={2}><><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></></Svg>
                <div className="ttl">Key not available yet</div>
                <div className="sub">Your room is not currently configured for digital access. Please contact reception for assistance.</div>
              </div>
            )}

            {/* PIN (collapsible backup) */}
            {boardingPass.pin && !isBlocked && (() => {
              const arrivalBase = new Date(boardingPass.reservation.arrival);
              const departureBase = new Date(boardingPass.reservation.departure);
              const [ciH, ciM] = (boardingPass.checkInTime || "15:00").split(":").map(Number);
              const [coH, coM] = (boardingPass.checkoutTime || "11:00").split(":").map(Number);
              const displayFrom = new Date(arrivalBase); displayFrom.setHours(ciH, ciM, 0, 0);
              const displayTo = new Date(departureBase); displayTo.setHours(coH, coM, 0, 0);
              const pinStatus = boardingPass.pin.status;
              const sub = pinStatus === "pending" ? "Activates at check-in" : "Only needed if a button doesn't work";
              return (
                <div className="dlk-block">
                  <div className={`dlk-pinwrap${pinOpen ? " open" : ""}`}>
                    <button className="toggle" type="button" aria-expanded={pinOpen} onClick={() => setPinOpen(o => !o)}>
                      <span className="ico"><Svg sw={2}><><rect x="4" y="11" width="16" height="10" rx="2.5" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></></Svg></span>
                      <span className="lab">PIN code<small>{sub}</small></span>
                      <span className="chev"><Svg sw={2.5} d="m6 9 6 6 6-6" /></span>
                    </button>
                    <div className="body">
                      <div className="inner">
                        <div className="dlk-digits" data-testid="text-pin-code">
                          {boardingPass.pin.code.split("").map((d, i) => (<span className="d" key={i}>{d}</span>))}
                        </div>
                        <div className="dlk-valid">Valid <b>{format(displayFrom, "MMM dd, HH:mm")}</b> – <b>{format(displayTo, "MMM dd, HH:mm")}</b></div>
                        <div><button className={`dlk-copy${copied ? " copied" : ""}`} type="button" onClick={copyPin}>
                          <Svg sw={2}><><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></></Svg>
                          <span>{copied ? "Copied!" : "Tap to copy"}</span>
                        </button></div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* STAY */}
            <div className="dlk-block tight">
              <div className="dlk-stay">
                <div className="col in">
                  <div className="k"><Svg sw={2}><><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></></Svg>Check-in</div>
                  <div className="v" data-testid="text-checkin">{format(new Date(boardingPass.reservation.arrival), "MMM dd, yyyy")}</div>
                  <div className="time">{boardingPass.checkInTime || "15:00"}</div>
                </div>
                <div className="mid"><div className="nights" /><div className="line" /></div>
                <div className="col out">
                  <div className="k"><Svg sw={2}><><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></></Svg>Check-out</div>
                  <div className="v" data-testid="text-checkout">{format(new Date(boardingPass.reservation.departure), "MMM dd, yyyy")}</div>
                  <div className="time">{boardingPass.checkoutTime || "11:00"}</div>
                </div>
              </div>
            </div>

            {/* RESERVATION */}
            <div className="dlk-block tight">
              <div className="dlk-res">
                <div><div className="k">Reservation number</div></div>
                <div className="v" data-testid="text-confirmation">{boardingPass.reservation.reservationNumber}</div>
              </div>
            </div>

            {/* EMAIL */}
            <div className="dlk-block tight">
              <div className="dlk-email">
                <div className="lab">
                  <Svg sw={2}><><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m2 6 10 7L22 6" /></></Svg>
                  Send digital key to email
                </div>
                <div className="field">
                  <input
                    type="email"
                    placeholder="Enter email address"
                    value={emailToSend}
                    onChange={(e) => setEmailToSend(e.target.value)}
                    data-testid="input-send-email"
                  />
                  <button onClick={sendBoardingPassToEmail} disabled={sendingEmail || !emailToSend.includes("@")} data-testid="button-send-email">
                    <Svg sw={2}><><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></></Svg>
                    {sendingEmail ? "…" : "Send"}
                  </button>
                </div>
              </div>
            </div>

            <div className="dlk-foot">Secured by DreamBoks</div>
          </div>
        )}
      </div>

      {showInstallBanner && (
        <div className="dlk-banner">
          <div className="inner">
            <div className="ic"><Svg sw={2}><><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></></Svg></div>
            <div className="tx">
              <div className="t">Install {brandName} Key</div>
              {isIOS ? (
                <div className="s">Tap Share, then "Add to Home Screen"</div>
              ) : (
                <div className="s">Add to your home screen for quick access</div>
              )}
            </div>
            {!isIOS && deferredPrompt && (
              <button className="act" onClick={handleInstallClick} data-testid="button-install-pwa">Install</button>
            )}
            <button className="x" onClick={dismissInstallBanner} data-testid="button-dismiss-install">
              <Svg sw={2} d="M18 6 6 18M6 6l12 12" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
