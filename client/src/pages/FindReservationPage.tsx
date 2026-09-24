import { useEffect, useState, type FormEvent } from "react";
import { useParams, useLocation } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, KeyRound, AlertCircle } from "lucide-react";
import { type GuestTheme, guestThemeStyle, useGuestFont, useFavicon, rgba } from "@/lib/guest-theme";

interface HotelInfo {
  name: string;
  slug: string;
  theme?: GuestTheme | null;
}

type FindResponse =
  | { found: true; multiple: false; token: string }
  | { found: true; multiple: true; count: number }
  | { found: false; error?: string };

export default function FindReservationPage() {
  const params = useParams<{ hotel: string }>();
  const [, setLocation] = useLocation();

  const [hotelInfo, setHotelInfo] = useState<HotelInfo | null>(null);
  const [lastName, setLastName] = useState("");
  const [reservationNumber, setReservationNumber] = useState("");
  const [showReservationField, setShowReservationField] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Find Reservation";
    if (!params.hotel) return;
    fetch(`/api/public/hotel-info/${params.hotel}`)
      .then((res) => res.json())
      .then((data) => {
        if (data?.name) {
          setHotelInfo(data);
          document.title = `Check-in - ${data.name}`;
        }
      })
      .catch(() => {});
  }, [params.hotel]);

  // Per-tenant guest-flow branding (Capsule green + acorn). null for default tenants.
  const theme = hotelInfo?.theme || null;
  const brand = theme?.brand || null;
  const rootStyle = guestThemeStyle(theme);
  useGuestFont(theme?.font);
  useFavicon(theme?.logoUrl, brand);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!params.hotel) return;

    const lastNameTrim = lastName.trim();
    if (lastNameTrim.length < 2) {
      setError("Please enter your last name (at least 2 characters).");
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const response = await fetch("/api/public/find-reservation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hotelSlug: params.hotel,
          lastName: lastNameTrim,
          reservationNumber: reservationNumber.trim() || undefined,
        }),
      });

      const data: FindResponse & { error?: string } = await response.json();

      if (!response.ok) {
        if (response.status === 429) {
          setError("Too many attempts. Please try again in an hour.");
        } else if (response.status === 404) {
          setError(
            showReservationField
              ? "No reservation matches that last name and reservation number. Please contact reception."
              : "No reservation found for that last name. Please check the spelling or contact reception."
          );
        } else {
          setError(data.error || "Lookup failed. Please try again.");
        }
        return;
      }

      if ("found" in data && data.found && "multiple" in data) {
        if (data.multiple) {
          setShowReservationField(true);
          setError(
            `${data.count} reservations match that last name. Please enter your reservation number to continue.`
          );
          return;
        }
        if (data.token) {
          setLocation(`/check-in/${data.token}`);
          return;
        }
      }

      setError("Unexpected response. Please try again.");
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen bg-[#c8d5e9]/30 flex items-center justify-center p-4"
      style={theme?.font ? { ...rootStyle, fontFamily: "var(--guest-font)" } : rootStyle}
    >
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center space-y-3">
          {theme?.logoUrl ? (
            <div
              className="mx-auto rounded-2xl flex items-center justify-center px-5 py-4"
              style={{ background: brand || "#cc352a" }}
            >
              <img src={theme.logoUrl} alt={hotelInfo?.name || ""} className="h-10 w-auto" />
            </div>
          ) : (
            <div
              className="mx-auto w-12 h-12 rounded-full bg-[#cc352a]/10 flex items-center justify-center"
              style={brand ? { backgroundColor: rgba(brand, 0.1) } : undefined}
            >
              <KeyRound className="w-6 h-6 text-[#cc352a]" style={brand ? { color: brand } : undefined} />
            </div>
          )}
          <CardTitle className="text-2xl text-[#232321]">
            {hotelInfo?.name || "Online Check-in"}
          </CardTitle>
          <CardDescription>
            Find your reservation to start online check-in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="lastName">Last name</Label>
              <Input
                id="lastName"
                type="text"
                autoComplete="family-name"
                value={lastName}
                onChange={(e) => {
                  setLastName(e.target.value);
                  setShowReservationField(false);
                  setReservationNumber("");
                  setError(null);
                }}
                disabled={loading}
                placeholder="As shown on your booking"
                required
              />
            </div>

            {showReservationField && (
              <div className="space-y-2">
                <Label htmlFor="reservationNumber">Reservation number</Label>
                <Input
                  id="reservationNumber"
                  type="text"
                  inputMode="numeric"
                  value={reservationNumber}
                  onChange={(e) => {
                    setReservationNumber(e.target.value);
                    setError(null);
                  }}
                  disabled={loading}
                  placeholder="From your confirmation email"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Same number shown on your boarding pass.
                </p>
              </div>
            )}

            {error && (
              <div
                className="flex items-start gap-2 text-sm text-[#cc352a] bg-[#cc352a]/5 border border-[#cc352a]/20 rounded-md p-3"
                style={brand ? { color: brand, backgroundColor: rgba(brand, 0.06), borderColor: rgba(brand, 0.2) } : undefined}
              >
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button
              type="submit"
              disabled={loading}
              className="w-full bg-[#cc352a] hover:bg-[#b02e24] text-white"
              style={brand ? { background: brand } : undefined}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Searching...
                </>
              ) : (
                "Find my reservation"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
