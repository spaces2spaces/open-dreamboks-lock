import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Star, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useSearch } from "wouter";
import { type GuestTheme, guestThemeStyle, useGuestFont, useFavicon } from "@/lib/guest-theme";

export default function RatingPage() {
  const { toast } = useToast();
  const searchString = useSearch();
  const [rating, setRating] = useState<number>(0);
  const [hoveredRating, setHoveredRating] = useState<number>(0);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [settings, setSettings] = useState<{
    goodUrl: string;
    badUrl: string;
    threshold: number;
  } | null>(null);
  const [theme, setTheme] = useState<GuestTheme | null>(null);

  useEffect(() => {
    // Tenant from URL params: ?t=<tenantId> (legacy) or ?hotel=<slug> (guest flow redirect).
    const params = new URLSearchParams(searchString);
    const tenantId = params.get("t") || "";
    const hotel = params.get("hotel") || "";

    const query = tenantId
      ? `?t=${encodeURIComponent(tenantId)}`
      : hotel
      ? `?hotel=${encodeURIComponent(hotel)}`
      : "";

    fetch(`/api/public/rating-settings${query}`)
      .then(res => res.json())
      .then(data => {
        setSettings({
          goodUrl: data.goodUrl || "",
          badUrl: data.badUrl || "",
          threshold: parseInt(data.threshold) || 4,
        });
        setTheme(data.theme || null);
        document.title = `Rate Your Stay - ${data.theme?.name || "DreamBoks"}`;
      })
      .catch(err => {
        console.error("Failed to load rating settings:", err);
      });
  }, [searchString]);

  const brand = theme?.brand || null;
  const rootStyle = guestThemeStyle(theme);
  useGuestFont(theme?.font);
  useFavicon(theme?.logoUrl, brand);
  const rootStyled = theme?.font ? { ...rootStyle, fontFamily: "var(--guest-font)" } : rootStyle;

  const handleSubmit = () => {
    if (rating === 0) {
      toast({ title: "Please select a rating", variant: "destructive" });
      return;
    }

    setLoading(true);
    setSubmitted(true);

    setTimeout(() => {
      if (settings) {
        let redirectUrl = rating >= settings.threshold ? settings.goodUrl : settings.badUrl;
        if (redirectUrl) {
          // Ensure URL has protocol prefix
          if (!redirectUrl.startsWith('http://') && !redirectUrl.startsWith('https://')) {
            redirectUrl = 'https://' + redirectUrl;
          }
          window.location.href = redirectUrl;
        }
      }
      setLoading(false);
    }, 1500);
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-[#c8d5e9] to-white flex items-center justify-center p-4" style={rootStyled}>
        <Card className="w-full max-w-md shadow-xl">
          <CardContent className="pt-8 pb-8 text-center">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-8 h-8 text-green-600" />
            </div>
            <h2 className="text-2xl font-bold text-[#232321] mb-2">Thank You!</h2>
            <p className="text-muted-foreground">
              We appreciate your feedback. {loading ? "Redirecting..." : ""}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#c8d5e9] to-white flex items-center justify-center p-4" style={rootStyled}>
      <Card className="w-full max-w-md shadow-xl">
        <CardHeader className="text-center pb-2">
          <div
            className="w-16 h-16 bg-[#cc352a] rounded-xl flex items-center justify-center mx-auto mb-4"
            style={brand ? { background: brand } : undefined}
          >
            {theme?.logoUrl ? (
              <img src={theme.logoUrl} alt={theme.name || ""} className="h-10 w-auto" />
            ) : (
              <span className="text-white font-bold text-2xl">D</span>
            )}
          </div>
          <CardTitle className="text-2xl text-[#232321]">How was your stay?</CardTitle>
          <CardDescription>
            We'd love to hear about your experience
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex justify-center gap-2">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onClick={() => setRating(star)}
                onMouseEnter={() => setHoveredRating(star)}
                onMouseLeave={() => setHoveredRating(0)}
                className="p-1 transition-transform hover:scale-110"
                data-testid={`button-star-${star}`}
              >
                <Star
                  className={`w-12 h-12 transition-colors ${
                    star <= (hoveredRating || rating)
                      ? "fill-yellow-400 text-yellow-400"
                      : "text-gray-300"
                  }`}
                />
              </button>
            ))}
          </div>

          <div className="text-center text-sm text-muted-foreground">
            {rating === 0 && "Tap a star to rate"}
            {rating === 1 && "Very Poor"}
            {rating === 2 && "Poor"}
            {rating === 3 && "Average"}
            {rating === 4 && "Good"}
            {rating === 5 && "Excellent!"}
          </div>

          <Button
            className="w-full bg-[#cc352a] hover:bg-[#a82b22] text-white"
            size="lg"
            onClick={handleSubmit}
            disabled={rating === 0 || loading}
            data-testid="button-submit-rating"
            style={brand ? { background: brand } : undefined}
          >
            Submit Rating
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
