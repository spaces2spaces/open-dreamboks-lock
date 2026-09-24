import { useState, useEffect, useRef } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Loader2, CheckCircle, Clock, CreditCard, AlertCircle, Calendar, Mail, User, Globe, FileText, ChevronRight, ChevronLeft, MapPin } from "lucide-react";
import { type GuestTheme, useGuestFont, useFavicon, hexToHslComponents } from "@/lib/guest-theme";

interface CheckInInfo {
  reservation: {
    id: string;
    guestName: string;
    arrival: string;
    departure: string;
    room: string | null;
    email: string | null;
    confirmationCode: string | null;
    preCheckinStatus: string;
    codeDeliveredAt: string | null;
    owing: string | null;
    currency: string | null;
    paymentVerifiedAt: string | null;
  };
  canCheckIn: boolean;
  checkInAvailableFrom: string;
  requireGuestProfile?: boolean;
  theme?: GuestTheme | null;
}

interface CheckInResult {
  success: boolean;
  status: "paid" | "awaiting_payment" | "error" | "too_early" | "already_sent" | "mews_sync_failed" | "notification_failed";
  message: string;
  passcode?: string;
  mewsSyncFailed?: boolean;
  notificationFailed?: boolean;
  reservation?: {
    owing: string | null;
    currency: string | null;
  };
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

export default function CheckInPage() {
  const { token } = useParams<{ token: string }>();
  const [checkInResult, setCheckInResult] = useState<CheckInResult | null>(null);
  const [personalEmail, setPersonalEmail] = useState("");
  const preferredChannel = "email" as const;
  const [step, setStep] = useState<"payment" | "contact" | "profile" | "submitting">("contact");

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

  const { data: checkInInfo, isLoading, error, refetch, isRefetching } = useQuery<CheckInInfo>({
    queryKey: ["/api/public/check-in", token],
    queryFn: async () => {
      const response = await fetch(`/api/public/check-in/${token}`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to load check-in information");
      }
      return response.json();
    },
    enabled: !!token && token.length >= 32,
  });

  // Per-tenant guest-flow branding (Capsule). Override shadcn --primary + body font
  // while this page is mounted so all primary buttons/steps follow the brand; restore
  // on unmount. No-op (and byte-identical default look) when no theme is returned.
  const theme = checkInInfo?.theme || null;
  const brand = theme?.brand || null;
  useGuestFont(theme?.font);
  useFavicon(theme?.logoUrl, brand);
  useEffect(() => {
    if (!brand && !theme?.font) return;
    const rootEl = document.documentElement;
    const prevPrimary = rootEl.style.getPropertyValue("--primary");
    const prevFont = document.body.style.fontFamily;
    if (brand) rootEl.style.setProperty("--primary", hexToHslComponents(brand));
    if (theme?.font) document.body.style.fontFamily = `"${theme.font}", system-ui, -apple-system, sans-serif`;
    return () => {
      if (prevPrimary) rootEl.style.setProperty("--primary", prevPrimary);
      else rootEl.style.removeProperty("--primary");
      document.body.style.fontFamily = prevFont;
    };
  }, [brand, theme?.font]);

  // Set initial step to "payment" when reservation has outstanding balance
  const initialStepSet = useRef(false);
  useEffect(() => {
    if (!checkInInfo) return;
    const owing = checkInInfo.reservation.owing ? parseFloat(checkInInfo.reservation.owing) : 0;
    const isPaid = owing <= 0 || !!checkInInfo.reservation.paymentVerifiedAt;

    if (!initialStepSet.current) {
      initialStepSet.current = true;
      if (!isPaid) {
        setStep("payment");
      }
    } else if (isPaid) {
      // After refetch: balance is now paid, advance to contact if still on payment
      setStep((prev) => (prev === "payment" ? "contact" : prev));
    }
  }, [checkInInfo]);

  const buildGuestProfile = (): GuestProfile | undefined => {
    if (!checkInInfo?.requireGuestProfile) return undefined;

    const profile: GuestProfile = {};

    if (nationality) profile.nationality = nationality;
    if (birthDate) profile.birthDate = birthDate;

    if (addressLine1) {
      profile.address = {
        line1: addressLine1,
        city: addressCity || undefined,
        postalCode: addressPostalCode || undefined,
        countryCode: addressCountry || undefined,
      };
    }

    if (idNumber) {
      profile.identityDocument = {
        type: idType,
        number: idNumber,
        expiration: idExpiration || undefined,
        issuingCountryCode: idIssuingCountry || undefined,
      };
    }

    return Object.keys(profile).length > 0 ? profile : undefined;
  };

  const initiateCheckIn = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/public/check-in/${token}/initiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          personalEmail: personalEmail || undefined,
          preferredChannel: preferredChannel || undefined,
          guestProfile: buildGuestProfile(),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "Failed to process check-in");
      }
      return data;
    },
    onSuccess: (data) => {
      setCheckInResult(data);
    },
  });

  const requestPayment = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/public/check-in/${token}/request-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      return response.json();
    },
    onSuccess: (data) => {
      if (data.paymentUrl) {
        window.location.href = data.paymentUrl;
      }
    },
  });

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  };

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const isProfileValid = (): boolean => {
    if (!checkInInfo?.requireGuestProfile) return true;
    return !!(nationality && idNumber && idType);
  };

  if (!token || token.length < 32) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4" data-testid="checkin-invalid-token">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-destructive">Invalid Link</CardTitle>
          </CardHeader>
          <CardContent>
            <p>This check-in link is invalid or has expired. Please contact the hotel for assistance.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50" data-testid="checkin-loading">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4" data-testid="checkin-error">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-destructive">Check-in Not Available</CardTitle>
          </CardHeader>
          <CardContent>
            <p>{(error as Error).message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!checkInInfo) {
    return null;
  }

  const { reservation, canCheckIn, checkInAvailableFrom } = checkInInfo;
  const requireProfile = checkInInfo.requireGuestProfile;

  const isSuccessState = reservation.preCheckinStatus === "code_sent" || 
                         reservation.preCheckinStatus === "mews_sync_failed" ||
                         checkInResult?.status === "already_sent" || 
                         checkInResult?.status === "paid" ||
                         checkInResult?.status === "mews_sync_failed";
  
  const hasMewsSyncIssue = reservation.preCheckinStatus === "mews_sync_failed" || 
                           checkInResult?.status === "mews_sync_failed" ||
                           checkInResult?.mewsSyncFailed;

  if (isSuccessState) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4" data-testid="checkin-success">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className={`mx-auto mb-4 h-16 w-16 rounded-full ${hasMewsSyncIssue ? 'bg-yellow-100' : 'bg-green-100'} flex items-center justify-center`}>
              <CheckCircle className={`h-10 w-10 ${hasMewsSyncIssue ? 'text-yellow-600' : 'text-green-600'}`} />
            </div>
            <CardTitle className={hasMewsSyncIssue ? 'text-yellow-600' : 'text-green-600'}>
              {hasMewsSyncIssue ? 'Access Code Sent!' : 'Check-in Complete!'}
            </CardTitle>
            <CardDescription>
              {hasMewsSyncIssue 
                ? 'Your access code has been sent (staff will complete your check-in)' 
                : 'Your access code has been sent'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {hasMewsSyncIssue && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-center mb-4">
                <p className="text-sm text-yellow-800">
                  <AlertCircle className="h-4 w-4 inline mr-1" />
                  Note: The hotel system needs staff to complete your check-in. 
                  You will still have access with your code.
                </p>
              </div>
            )}
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-center">
              <p className="text-sm text-green-800">
                Your access code has been sent to your email{reservation.email ? ` (${reservation.email})` : ""}.
              </p>
              {checkInResult?.passcode && (
                <p className="mt-2 text-2xl font-bold text-green-700" data-testid="passcode-display">
                  {checkInResult.passcode}
                </p>
              )}
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-gray-400" />
                <span>Check-in: {formatDate(reservation.arrival)}</span>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-gray-400" />
                <span>Check-out: {formatDate(reservation.departure)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!canCheckIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4" data-testid="checkin-too-early">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-blue-100 flex items-center justify-center">
              <Clock className="h-10 w-10 text-blue-600" />
            </div>
            <CardTitle>Online Check-in</CardTitle>
            <CardDescription>Welcome, {reservation.guestName}!</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <Clock className="h-4 w-4" />
              <AlertTitle>Check-in not yet available</AlertTitle>
              <AlertDescription>
                Online check-in opens 24 hours before your arrival.
                <br />
                <strong>Available from: {formatDate(checkInAvailableFrom)} at {formatTime(checkInAvailableFrom)}</strong>
              </AlertDescription>
            </Alert>

            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-gray-400" />
                <span>Arrival: {formatDate(reservation.arrival)}</span>
              </div>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-gray-400" />
                <span>Departure: {formatDate(reservation.departure)}</span>
              </div>
              {reservation.confirmationCode && (
                <div className="flex items-center gap-2">
                  <span className="text-gray-400">#</span>
                  <span>Confirmation: {reservation.confirmationCode}</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (checkInResult?.status === "awaiting_payment") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4" data-testid="checkin-payment-required">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-amber-100 flex items-center justify-center">
              <CreditCard className="h-10 w-10 text-amber-600" />
            </div>
            <CardTitle>Payment Required</CardTitle>
            <CardDescription>Please complete your payment to receive your access code</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Outstanding Balance</AlertTitle>
              <AlertDescription>
                Your reservation has an outstanding balance of{" "}
                <span className="font-bold text-lg">
                  {checkInResult.reservation?.owing || checkInInfo.reservation.owing || "0"}{" "}
                  {checkInResult.reservation?.currency || checkInInfo.reservation.currency || "EUR"}
                </span>
                . Please complete payment to continue with online check-in.
              </AlertDescription>
            </Alert>

            <div className="space-y-3">
              <Button
                className="w-full"
                onClick={() => requestPayment.mutate()}
                disabled={requestPayment.isPending}
                data-testid="button-request-payment"
              >
                {requestPayment.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Opening payment...
                  </>
                ) : (
                  <>
                    <CreditCard className="mr-2 h-4 w-4" />
                    Pay now
                  </>
                )}
              </Button>

              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setCheckInResult(null);
                  initiateCheckIn.mutate();
                }}
                disabled={initiateCheckIn.isPending}
                data-testid="button-retry-checkin"
              >
                I've already paid - retry check-in
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4" data-testid="checkin-ready">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          {theme?.logoUrl && (
            <div className="mx-auto mb-2 rounded-2xl flex items-center justify-center px-5 py-3" style={{ background: brand || "#cc352a" }}>
              <img src={theme.logoUrl} alt={theme.name || ""} className="h-9 w-auto" />
            </div>
          )}
          {theme?.name && <div className="text-sm font-semibold" style={{ color: brand || undefined }}>{theme.name}</div>}
          <CardTitle>Online Check-in</CardTitle>
          <CardDescription>Welcome, {reservation.guestName}!</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-gray-400" />
              <span>Arrival: {formatDate(reservation.arrival)}</span>
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-gray-400" />
              <span>Departure: {formatDate(reservation.departure)}</span>
            </div>
          </div>

          {step !== "payment" && requireProfile && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <div className={`flex items-center gap-1 ${step === "contact" ? "text-primary font-medium" : "text-gray-400"}`}>
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${step === "contact" ? "bg-primary text-white" : "bg-gray-200"}`}>1</div>
                <span>Contact</span>
              </div>
              <ChevronRight className="h-3 w-3" />
              <div className={`flex items-center gap-1 ${step === "profile" ? "text-primary font-medium" : "text-gray-400"}`}>
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs ${step === "profile" ? "bg-primary text-white" : "bg-gray-200"}`}>2</div>
                <span>Guest Info</span>
              </div>
            </div>
          )}

          {step === "payment" && (
            <div className="space-y-4 border-t pt-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Outstanding Balance</AlertTitle>
                <AlertDescription>
                  Your reservation has an outstanding balance of{" "}
                  <span className="font-bold text-lg">
                    {reservation.owing || "0"} {reservation.currency || "EUR"}
                  </span>
                  . Please complete payment to continue with online check-in.
                </AlertDescription>
              </Alert>

              <div className="space-y-3">
                <Button
                  className="w-full"
                  size="lg"
                  onClick={() => requestPayment.mutate()}
                  disabled={requestPayment.isPending}
                  data-testid="button-pay-now"
                >
                  {requestPayment.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Opening payment...
                    </>
                  ) : (
                    <>
                      <CreditCard className="mr-2 h-4 w-4" />
                      Pay now
                    </>
                  )}
                </Button>

                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => refetch()}
                  disabled={isRefetching}
                  data-testid="button-already-paid"
                >
                  {isRefetching ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Checking payment status...
                    </>
                  ) : (
                    "I've already paid"
                  )}
                </Button>
              </div>
            </div>
          )}

          {step === "contact" && (
            <div className="space-y-3 border-t pt-4">
              <div className="space-y-2">
                <Label htmlFor="personalEmail" className="text-sm font-medium">
                  Your personal email address
                </Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    id="personalEmail"
                    type="email"
                    placeholder="your@email.com"
                    value={personalEmail}
                    onChange={(e) => setPersonalEmail(e.target.value)}
                    className="pl-10"
                    data-testid="input-personal-email"
                  />
                </div>
                <p className="text-xs text-gray-500">We'll send your digital key here</p>
              </div>
            </div>
          )}

          {step === "profile" && requireProfile && (
            <div className="space-y-4 border-t pt-4">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
                <User className="h-4 w-4" />
                <span>Personal Information</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="nationality" className="text-xs">
                    Nationality *
                  </Label>
                  <select
                    id="nationality"
                    value={nationality}
                    onChange={(e) => setNationality(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                    data-testid="select-nationality"
                  >
                    <option value="">Select...</option>
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="birthDate" className="text-xs">
                    Date of Birth
                  </Label>
                  <Input
                    id="birthDate"
                    type="date"
                    value={birthDate}
                    onChange={(e) => setBirthDate(e.target.value)}
                    className="h-9 text-sm"
                    data-testid="input-birthdate"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 text-sm font-medium text-gray-700 mt-4">
                <MapPin className="h-4 w-4" />
                <span>Address</span>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="addressLine1" className="text-xs">Street Address</Label>
                  <Input
                    id="addressLine1"
                    placeholder="123 Main Street"
                    value={addressLine1}
                    onChange={(e) => setAddressLine1(e.target.value)}
                    className="h-9 text-sm"
                    data-testid="input-address-line1"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="addressCity" className="text-xs">City</Label>
                    <Input
                      id="addressCity"
                      placeholder="City"
                      value={addressCity}
                      onChange={(e) => setAddressCity(e.target.value)}
                      className="h-9 text-sm"
                      data-testid="input-address-city"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="addressPostalCode" className="text-xs">Postal Code</Label>
                    <Input
                      id="addressPostalCode"
                      placeholder="12345"
                      value={addressPostalCode}
                      onChange={(e) => setAddressPostalCode(e.target.value)}
                      className="h-9 text-sm"
                      data-testid="input-address-postalcode"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="addressCountry" className="text-xs">Country</Label>
                  <select
                    id="addressCountry"
                    value={addressCountry}
                    onChange={(e) => setAddressCountry(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                    data-testid="select-address-country"
                  >
                    <option value="">Select...</option>
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>{c.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-2 text-sm font-medium text-gray-700 mt-4">
                <FileText className="h-4 w-4" />
                <span>ID Document *</span>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="idType" className="text-xs">Document Type</Label>
                  <select
                    id="idType"
                    value={idType}
                    onChange={(e) => setIdType(e.target.value as typeof idType)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                    data-testid="select-id-type"
                  >
                    {ID_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="idNumber" className="text-xs">Document Number *</Label>
                    <Input
                      id="idNumber"
                      placeholder="AB1234567"
                      value={idNumber}
                      onChange={(e) => setIdNumber(e.target.value)}
                      className="h-9 text-sm"
                      data-testid="input-id-number"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="idExpiration" className="text-xs">Expiration Date</Label>
                    <Input
                      id="idExpiration"
                      type="date"
                      value={idExpiration}
                      onChange={(e) => setIdExpiration(e.target.value)}
                      className="h-9 text-sm"
                      data-testid="input-id-expiration"
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="idIssuingCountry" className="text-xs">Issuing Country</Label>
                  <select
                    id="idIssuingCountry"
                    value={idIssuingCountry}
                    onChange={(e) => setIdIssuingCountry(e.target.value)}
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
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

          {step !== "payment" && <div className="flex gap-2">
            {step === "profile" && (
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setStep("contact")}
                data-testid="button-back"
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back
              </Button>
            )}

            {step === "contact" && requireProfile ? (
              <Button
                className="flex-1"
                size="lg"
                onClick={() => setStep("profile")}
                data-testid="button-next"
              >
                Next: Guest Info
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            ) : (
              <Button
                className="flex-1"
                size="lg"
                onClick={() => initiateCheckIn.mutate()}
                disabled={initiateCheckIn.isPending || (requireProfile && !isProfileValid())}
                data-testid="button-checkin"
              >
                {initiateCheckIn.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <CheckCircle className="mr-2 h-4 w-4" />
                    Check In Now
                  </>
                )}
              </Button>
            )}
          </div>}

          {requireProfile && step === "profile" && !isProfileValid() && (
            <p className="text-xs text-amber-600 text-center">
              Please fill in nationality and ID document number to continue
            </p>
          )}

          {initiateCheckIn.isError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {(initiateCheckIn.error as Error)?.message || "Failed to process check-in. Please try again."}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
