import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Loader2, KeyRound, Mail, ArrowRight, Calendar, MapPin, User, FileText, CreditCard, RefreshCw, CheckCircle2, Send } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { format } from "date-fns";
import { type GuestTheme, guestThemeStyle, useGuestFont, useFavicon } from "@/lib/guest-theme";

interface ReservationData {
  id: string;
  extId: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  mobile: string | null;
  arrival: string;
  departure: string;
  room: string | null;
  status: string;
  pin: string;
  preCheckinStatus: string;
  preCheckinToken: string | null;
  personalEmail: string | null;
  isPaid: boolean;
  owing: string | null;
  requireGuestProfile?: boolean;
  mewsCustomerId?: string | null;
}

interface HotelInfo {
  name: string;
  slug: string;
  theme?: GuestTheme | null;
  /** The page runs on a shared reception screen: show a QR after the code,
   *  never the boarding card itself. */
  kioskQr?: boolean;
}

interface GuestProfile {
  nationality?: string;
  birthDate?: string;
  address?: {
    line1?: string;
    city?: string;
    postalCode?: string;
    countryCode?: string;
  };
  identityDocument?: {
    type: "Passport" | "IdentityCard" | "DriversLicense";
    number: string;
    expiration?: string;
    issuingCountryCode?: string;
  };
}

const COUNTRIES = [
  { code: "DK", name: "Denmark" },
  { code: "SE", name: "Sweden" },
  { code: "NO", name: "Norway" },
  { code: "FI", name: "Finland" },
  { code: "DE", name: "Germany" },
  { code: "NL", name: "Netherlands" },
  { code: "GB", name: "United Kingdom" },
  { code: "US", name: "United States" },
  { code: "FR", name: "France" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "PT", name: "Portugal" },
  { code: "PL", name: "Poland" },
  { code: "CZ", name: "Czech Republic" },
  { code: "AT", name: "Austria" },
  { code: "CH", name: "Switzerland" },
  { code: "BE", name: "Belgium" },
  { code: "IE", name: "Ireland" },
  { code: "AU", name: "Australia" },
  { code: "CA", name: "Canada" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" },
  { code: "CN", name: "China" },
  { code: "IN", name: "India" },
  { code: "BR", name: "Brazil" },
  { code: "MX", name: "Mexico" },
  { code: "AR", name: "Argentina" },
  { code: "ZA", name: "South Africa" },
  { code: "IL", name: "Israel" },
  { code: "TR", name: "Turkey" },
  { code: "RU", name: "Russia" },
  { code: "UA", name: "Ukraine" },
  { code: "TH", name: "Thailand" },
  { code: "GR", name: "Greece" },
  { code: "HR", name: "Croatia" },
  { code: "RO", name: "Romania" },
  { code: "HU", name: "Hungary" },
  { code: "BG", name: "Bulgaria" },
  { code: "IS", name: "Iceland" },
  { code: "LT", name: "Lithuania" },
  { code: "LV", name: "Latvia" },
  { code: "EE", name: "Estonia" },
  { code: "SK", name: "Slovakia" },
  { code: "SI", name: "Slovenia" },
].sort((a, b) => a.name.localeCompare(b.name));

const ID_TYPES = [
  { value: "Passport", label: "Passport" },
  { value: "IdentityCard", label: "ID Card" },
  { value: "DriversLicense", label: "Driver's License" },
] as const;

export default function PinCheckinPage() {
  const { toast } = useToast();
  const params = useParams<{ hotel: string }>();
  const [, setLocation] = useLocation();
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [hotelInfo, setHotelInfo] = useState<HotelInfo | null>(null);
  const [reservation, setReservation] = useState<ReservationData | null>(null);
  const [step, setStep] = useState<"pin" | "details" | "boarding-pass-qr" | "awaiting-payment">("pin");
  const [emailToSend, setEmailToSend] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);
  const [personalEmail, setPersonalEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [paymentLinkSent, setPaymentLinkSent] = useState(false);
  const [sendingPaymentLink, setSendingPaymentLink] = useState(false);

  const [nationality, setNationality] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressCity, setAddressCity] = useState("");
  const [addressPostalCode, setAddressPostalCode] = useState("");
  const [addressCountry, setAddressCountry] = useState("");
  const [idType, setIdType] = useState<"Passport" | "IdentityCard" | "DriversLicense">("Passport");
  const [idNumber, setIdNumber] = useState("");
  const [idExpiration, setIdExpiration] = useState("");
  const [idIssuingCountry, setIdIssuingCountry] = useState("");

  useEffect(() => {
    document.title = "Online Check-in";

    if (params.hotel) {
      fetch(`/api/public/hotel-info/${params.hotel}`)
        .then(res => res.json())
        .then(data => {
          if (data.name) {
            setHotelInfo(data);
            document.title = `Check-in - ${data.name}`;
          }
        })
        .catch(() => {});
    }
  }, [params.hotel]);

  // Per-tenant guest-flow branding (Capsule). null for default tenants → kiosk stays
  // its current dark + red look.
  const theme = hotelInfo?.theme || null;
  const brand = theme?.brand || null;
  const rootStyle = guestThemeStyle(theme);
  const rootStyled = theme?.font ? { ...rootStyle, fontFamily: "var(--guest-font)" } : rootStyle;
  useGuestFont(theme?.font);
  useFavicon(theme?.logoUrl, brand);

  // Override the default PWA manifest so "Add to Home Screen" on this kiosk
  // page launches back to the check-in page (and not /boarding-pass which is
  // the manifest's default start_url for the guest boarding pass app).
  useEffect(() => {
    if (!params.hotel) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (!link) return;
    const originalHref = link.getAttribute("href");

    const manifest = {
      name: hotelInfo?.name ? `${hotelInfo.name} Check-in` : "DreamBoks Check-in",
      short_name: "Check-in",
      description: "Self-service check-in kiosk",
      start_url: `/${params.hotel}/checkin`,
      scope: `/${params.hotel}/checkin`,
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#cc352a",
      orientation: "portrait",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    };
    const blob = new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" });
    const blobUrl = URL.createObjectURL(blob);
    link.setAttribute("href", blobUrl);

    return () => {
      if (originalHref) link.setAttribute("href", originalHref);
      URL.revokeObjectURL(blobUrl);
    };
  }, [params.hotel, hotelInfo?.name]);

  const resetToStart = () => {
    setStep("pin");
    setPin("");
    setReservation(null);
    setPersonalEmail("");
    setEmailToSend("");
    setSendingEmail(false);
    setPaymentLinkSent(false);
    setSendingPaymentLink(false);
    setSubmitting(false);
    setLoading(false);
    setNationality("");
    setBirthDate("");
    setAddressLine1("");
    setAddressCity("");
    setAddressPostalCode("");
    setAddressCountry("");
    setIdType("Passport");
    setIdNumber("");
    setIdExpiration("");
    setIdIssuingCountry("");
  };

  const boardingPassUrl = (r: ReservationData) =>
    `${window.location.origin}/boarding-pass?res=${encodeURIComponent(r.extId || r.id)}&name=${encodeURIComponent(r.lastName)}${params.hotel ? `&hotel=${encodeURIComponent(params.hotel)}` : ""}`;

  /**
   * Where a valid code leads depends on whose screen this is.
   *
   * On a staffed reception's iPad (Copenhagen Downtown, `pin_checkin_kiosk_qr`)
   * the boarding card must never appear on the shared screen: a QR is shown
   * for the guest to scan with their own phone. On the guest's own phone
   * (Capsule: QR from the info screen, or the link from their email) there is
   * nothing to scan, so the page jumps straight to the card.
   */
  const finish = (r: ReservationData) => {
    if (hotelInfo?.kioskQr) {
      setReservation(r);
      setStep("boarding-pass-qr");
      return;
    }
    window.location.href = boardingPassUrl(r);
  };

  // Security: once the boarding-pass QR is shown, automatically return to the
  // PIN entry screen so it is not left ready for the next guest to obtain the
  // previous guest's boarding card. 15 s is enough to scan the code.
  useEffect(() => {
    if (step !== "boarding-pass-qr") return;
    const timer = setTimeout(resetToStart, 15000);
    return () => clearTimeout(timer);
  }, [step]);

  const sendBoardingPassToEmail = async () => {
    if (!reservation || !emailToSend || !emailToSend.includes("@")) {
      toast({ title: "Invalid email", description: "Please enter a valid email address", variant: "destructive" });
      return;
    }
    setSendingEmail(true);
    try {
      const response = await fetch("/api/public/send-boarding-pass-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reservationNumber: reservation.extId || reservation.id,
          lastName: reservation.lastName,
          email: emailToSend,
        }),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Could not send email");
      }
      toast({ title: "Email sent!", description: `Digital key sent to ${emailToSend}` });
      setEmailToSend("");
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Could not send email. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSendingEmail(false);
    }
  };

  const requireProfile = reservation?.requireGuestProfile;

  const isFormValid = () => {
    if (!personalEmail || !personalEmail.includes("@")) return false;
    if (requireProfile && (!nationality || !idNumber || !idType)) return false;
    return true;
  };

  const lookupByPin = async () => {
    if (!pin || pin.length !== 4) {
      toast({
        title: "Invalid code",
        description: "Please enter a 4-digit code",
        variant: "destructive",
      });
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/public/lookup-by-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          pin, 
          hotelSlug: params.hotel 
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Reservation not found");
      }

      const data = await response.json();
      setReservation(data);

      if (!data.isPaid) {
        setStep("awaiting-payment");
      } else {
        finish(data);
      }
    } catch (error) {
      toast({
        title: "Not found",
        description: error instanceof Error ? error.message : "Could not find reservation with this code",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const buildGuestProfile = (): GuestProfile | undefined => {
    if (!requireProfile) return undefined;

    return {
      nationality: nationality || undefined,
      birthDate: birthDate || undefined,
      address: (addressLine1 || addressCity || addressPostalCode || addressCountry) ? {
        line1: addressLine1 || undefined,
        city: addressCity || undefined,
        postalCode: addressPostalCode || undefined,
        countryCode: addressCountry || undefined,
      } : undefined,
      identityDocument: (idNumber && idType) ? {
        type: idType,
        number: idNumber,
        expiration: idExpiration || undefined,
        issuingCountryCode: idIssuingCountry || undefined,
      } : undefined,
    };
  };

  const submitCheckin = async () => {
    if (!isFormValid()) {
      toast({
        title: "Missing information",
        description: requireProfile 
          ? "Please fill in email, nationality and ID document number"
          : "Please enter a valid email address",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/public/save-personal-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          reservationId: reservation?.id,
          personalEmail,
          pin,
          guestProfile: buildGuestProfile(),
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Could not complete check-in");
      }

      toast({
        title: "Check-in complete!",
        description: "Your digital key has been sent to your email",
      });
      if (reservation) finish(reservation);
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Could not complete check-in. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const sendPaymentLink = async (token?: string | null) => {
    const t = token ?? reservation?.preCheckinToken;
    if (!t) return;
    setSendingPaymentLink(true);
    try {
      await fetch(`/api/public/check-in/${t}/request-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      setPaymentLinkSent(true);
    } catch {
      // silent — user can retry manually
    } finally {
      setSendingPaymentLink(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 to-slate-800 flex items-center justify-center p-4" style={rootStyled}>
      <Card className="w-full max-w-md bg-slate-800 border-slate-700">
        <CardHeader className="text-center">
          <div
            className="mx-auto w-16 h-16 bg-red-600 rounded-full flex items-center justify-center mb-4"
            style={brand ? { background: brand } : undefined}
          >
            {theme?.logoUrl ? (
              <img src={theme.logoUrl} alt={hotelInfo?.name || ""} className="h-9 w-auto" />
            ) : (
              <KeyRound className="w-8 h-8 text-white" />
            )}
          </div>
          <CardTitle className="text-2xl text-white">
            {hotelInfo?.name || "Online Check-in"}
          </CardTitle>
          <CardDescription className="text-slate-400">
            {step === "pin" && "Enter your 4-digit access code"}
            {step === "details" && "Complete your check-in details"}
            {step === "boarding-pass-qr" && "Your boarding pass"}
            {step === "awaiting-payment" && "Payment required"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">

          {step === "pin" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="pin" className="text-slate-300">Access Code</Label>
                <Input
                  id="pin"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={4}
                  placeholder="1234"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  className="text-center text-3xl tracking-[0.5em] bg-slate-700 border-slate-600 text-white h-16"
                  data-testid="input-pin"
                />
              </div>
              <Button
                onClick={lookupByPin}
                disabled={loading || pin.length !== 4}
                className="w-full bg-[var(--brand,#dc2626)] hover:bg-[var(--brand-dark,#b91c1c)] text-white h-12"
                data-testid="button-lookup"
              >
                {loading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    Continue
                    <ArrowRight className="w-5 h-5 ml-2" />
                  </>
                )}
              </Button>
            </>
          )}

          {step === "details" && reservation && (
            <>
              <div className="bg-slate-700/50 rounded-lg p-4 space-y-2">
                <p className="text-white font-medium">Welcome, {reservation.firstName}!</p>
                <div className="flex items-center gap-2 text-slate-300">
                  <MapPin className="w-4 h-4" />
                  <span>Room: {reservation.room || "Assigned at arrival"}</span>
                </div>
                <div className="flex items-center gap-2 text-slate-300">
                  <Calendar className="w-4 h-4" />
                  <span>{format(new Date(reservation.arrival), "MMM d")} - {format(new Date(reservation.departure), "MMM d, yyyy")}</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="email" className="text-slate-300">
                  <Mail className="w-4 h-4 inline mr-2" />
                  Your Personal Email *
                </Label>
                <p className="text-sm text-slate-400">
                  We'll send your digital key to this email
                </p>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={personalEmail}
                  onChange={(e) => setPersonalEmail(e.target.value)}
                  className="bg-slate-700 border-slate-600 text-white"
                  data-testid="input-personal-email"
                />
              </div>

              {requireProfile && (
                <div className="space-y-4 border-t border-slate-700 pt-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
                    <User className="h-4 w-4" />
                    <span>Personal Information</span>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="nationality" className="text-xs text-slate-400">
                        Nationality *
                      </Label>
                      <select
                        id="nationality"
                        value={nationality}
                        onChange={(e) => setNationality(e.target.value)}
                        className="w-full h-9 rounded-md border border-slate-600 bg-slate-700 px-3 text-sm text-white"
                        data-testid="select-nationality"
                      >
                        <option value="">Select...</option>
                        {COUNTRIES.map((c) => (
                          <option key={c.code} value={c.code}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="birthDate" className="text-xs text-slate-400">
                        Date of Birth
                      </Label>
                      <Input
                        id="birthDate"
                        type="date"
                        value={birthDate}
                        onChange={(e) => setBirthDate(e.target.value)}
                        className="h-9 text-sm bg-slate-700 border-slate-600 text-white"
                        data-testid="input-birthdate"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-sm font-medium text-slate-300 mt-4">
                    <MapPin className="h-4 w-4" />
                    <span>Address</span>
                  </div>

                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label htmlFor="addressLine1" className="text-xs text-slate-400">Street Address</Label>
                      <Input
                        id="addressLine1"
                        placeholder="123 Main Street"
                        value={addressLine1}
                        onChange={(e) => setAddressLine1(e.target.value)}
                        className="h-9 text-sm bg-slate-700 border-slate-600 text-white"
                        data-testid="input-address-line1"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="addressCity" className="text-xs text-slate-400">City</Label>
                        <Input
                          id="addressCity"
                          placeholder="City"
                          value={addressCity}
                          onChange={(e) => setAddressCity(e.target.value)}
                          className="h-9 text-sm bg-slate-700 border-slate-600 text-white"
                          data-testid="input-address-city"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="addressPostalCode" className="text-xs text-slate-400">Postal Code</Label>
                        <Input
                          id="addressPostalCode"
                          placeholder="12345"
                          value={addressPostalCode}
                          onChange={(e) => setAddressPostalCode(e.target.value)}
                          className="h-9 text-sm bg-slate-700 border-slate-600 text-white"
                          data-testid="input-address-postalcode"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="addressCountry" className="text-xs text-slate-400">Country</Label>
                      <select
                        id="addressCountry"
                        value={addressCountry}
                        onChange={(e) => setAddressCountry(e.target.value)}
                        className="w-full h-9 rounded-md border border-slate-600 bg-slate-700 px-3 text-sm text-white"
                        data-testid="select-address-country"
                      >
                        <option value="">Select...</option>
                        {COUNTRIES.map((c) => (
                          <option key={c.code} value={c.code}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-sm font-medium text-slate-300 mt-4">
                    <FileText className="h-4 w-4" />
                    <span>ID Document *</span>
                  </div>

                  <div className="space-y-3">
                    <div className="space-y-1">
                      <Label htmlFor="idType" className="text-xs text-slate-400">Document Type</Label>
                      <select
                        id="idType"
                        value={idType}
                        onChange={(e) => setIdType(e.target.value as typeof idType)}
                        className="w-full h-9 rounded-md border border-slate-600 bg-slate-700 px-3 text-sm text-white"
                        data-testid="select-id-type"
                      >
                        {ID_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label htmlFor="idNumber" className="text-xs text-slate-400">Document Number *</Label>
                        <Input
                          id="idNumber"
                          placeholder="AB1234567"
                          value={idNumber}
                          onChange={(e) => setIdNumber(e.target.value)}
                          className="h-9 text-sm bg-slate-700 border-slate-600 text-white"
                          data-testid="input-id-number"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="idExpiration" className="text-xs text-slate-400">Expiration Date</Label>
                        <Input
                          id="idExpiration"
                          type="date"
                          value={idExpiration}
                          onChange={(e) => setIdExpiration(e.target.value)}
                          className="h-9 text-sm bg-slate-700 border-slate-600 text-white"
                          data-testid="input-id-expiration"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="idIssuingCountry" className="text-xs text-slate-400">Issuing Country</Label>
                      <select
                        id="idIssuingCountry"
                        value={idIssuingCountry}
                        onChange={(e) => setIdIssuingCountry(e.target.value)}
                        className="w-full h-9 rounded-md border border-slate-600 bg-slate-700 px-3 text-sm text-white"
                        data-testid="select-id-issuing-country"
                      >
                        <option value="">Select...</option>
                        {COUNTRIES.map((c) => (
                          <option key={c.code} value={c.code}>{c.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {requireProfile && !isFormValid() && personalEmail.includes("@") && (
                <p className="text-xs text-amber-400 text-center">
                  Please fill in nationality and ID document number to continue
                </p>
              )}

              <Button
                onClick={submitCheckin}
                disabled={submitting || !isFormValid()}
                className="w-full bg-[var(--brand,#dc2626)] hover:bg-[var(--brand-dark,#b91c1c)] text-white h-12"
                data-testid="button-complete-checkin"
              >
                {submitting ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    Complete Check-in
                    <ArrowRight className="w-5 h-5 ml-2" />
                  </>
                )}
              </Button>
            </>
          )}

          {step === "boarding-pass-qr" && reservation && (
            <>
              <div className="text-center">
                <CheckCircle2 className="w-12 h-12 text-green-400 mx-auto mb-3" />
                <h3 className="text-lg text-white font-semibold">Welcome, {reservation.firstName}!</h3>
                <p className="text-slate-400 text-sm mt-1">Scan the code with your phone to open your boarding pass</p>
              </div>

              <div className="flex flex-col items-center gap-3 bg-white rounded-xl p-4">
                <QRCodeSVG
                  value={boardingPassUrl(reservation)}
                  size={220}
                  level="M"
                />
                <p className="text-xs text-gray-500 text-center">
                  {reservation.firstName} {reservation.lastName} · Room {reservation.room || "TBD"}
                </p>
              </div>

              <div className="space-y-2 pt-2">
                <p className="text-sm text-slate-400 text-center">Or send the boarding pass to an email</p>
                <div className="flex gap-2">
                  <Input
                    type="email"
                    placeholder="Enter email address"
                    value={emailToSend}
                    onChange={(e) => setEmailToSend(e.target.value)}
                    className="flex-1 bg-slate-700 border-slate-600 text-white"
                    data-testid="input-send-email"
                  />
                  <Button
                    onClick={sendBoardingPassToEmail}
                    disabled={sendingEmail || !emailToSend.includes("@")}
                    className="bg-[var(--brand,#dc2626)] hover:bg-[var(--brand-dark,#b91c1c)] text-white"
                    data-testid="button-send-email"
                  >
                    {sendingEmail ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </Button>
                </div>
              </div>

              <Button
                onClick={resetToStart}
                className="w-full bg-slate-700 hover:bg-slate-600 text-white h-12 mt-2"
                data-testid="button-done"
              >
                Close
              </Button>
              <p className="text-xs text-slate-500 text-center">
                This screen returns to the start automatically.
              </p>
            </>
          )}

          {step === "awaiting-payment" && reservation && (
            <>
              <div className="text-center">
                <CreditCard className="w-12 h-12 text-amber-400 mx-auto mb-3" />
                <h3 className="text-lg text-white font-semibold">Payment required</h3>
                <p className="text-slate-400 text-sm mt-1">
                  {reservation.owing && parseFloat(reservation.owing) > 0
                    ? `Outstanding balance: ${parseFloat(reservation.owing).toLocaleString("da-DK", { minimumFractionDigits: 2 })} kr`
                    : "Your reservation has an outstanding balance"}
                </p>
                <p className="text-slate-500 text-xs mt-2">
                  Please complete payment to continue with check-in
                </p>
              </div>

              <Button
                onClick={async () => {
                  const t = reservation.preCheckinToken;
                  if (!t) return;
                  setSendingPaymentLink(true);
                  try {
                    const res = await fetch(`/api/public/check-in/${t}/request-payment`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                    });
                    const data = await res.json();
                    if (data.paymentUrl) {
                      window.location.href = data.paymentUrl;
                    }
                  } catch {
                    toast({
                      title: "Error",
                      description: "Could not open payment page. Please try again.",
                      variant: "destructive",
                    });
                  } finally {
                    setSendingPaymentLink(false);
                  }
                }}
                disabled={sendingPaymentLink}
                className="w-full bg-[var(--brand,#dc2626)] hover:bg-[var(--brand-dark,#b91c1c)] text-white h-12"
                data-testid="button-pay-now"
              >
                {sendingPaymentLink ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <>
                    <CreditCard className="w-5 h-5 mr-2" />
                    Pay now
                  </>
                )}
              </Button>

              <Button
                onClick={async () => {
                  setLoading(true);
                  try {
                    const response = await fetch("/api/public/lookup-by-pin", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ pin, hotelSlug: params.hotel }),
                    });
                    if (!response.ok) throw new Error("Could not verify payment");
                    const data = await response.json();
                    setReservation(data);
                    if (data.isPaid) {
                      finish(data);
                    } else {
                      toast({
                        title: "Payment not yet received",
                        description: "Please complete the payment and try again",
                        variant: "destructive",
                      });
                    }
                  } catch {
                    toast({
                      title: "Error",
                      description: "Could not check payment status",
                      variant: "destructive",
                    });
                  } finally {
                    setLoading(false);
                  }
                }}
                disabled={loading}
                variant="outline"
                className="w-full border-slate-600 text-slate-300"
                data-testid="button-already-paid"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <RefreshCw className="w-4 h-4 mr-2" />
                )}
                I've already paid
              </Button>

              <Button
                onClick={resetToStart}
                variant="ghost"
                className="w-full text-slate-400 hover:text-white hover:bg-slate-700"
                data-testid="button-back-from-payment"
              >
                Back
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
