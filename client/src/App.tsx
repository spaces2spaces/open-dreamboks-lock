import { lazy, Suspense, useEffect, useState } from "react";
import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isAuthenticated } from "@/lib/auth";

// Every page is lazy: guests arriving from an SMS link (/extras, /checkin, …)
// must not download the whole admin app — one shared 856 kB bundle made the
// guest pages painfully slow on mobile (30/7).
const SpacesPage = lazy(() => import("@/pages/SpacesPage"));
const LogsPage = lazy(() => import("@/pages/LogsPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));
const ReservationsPage = lazy(() => import("@/pages/ReservationsPage"));
const ArrivalsPage = lazy(() => import("@/pages/ArrivalsPage"));
const LockDevicesPage = lazy(() => import("@/pages/LockDevicesPage"));
const LockMappingPage = lazy(() => import("@/pages/LockMappingPage"));
const HourlyRentalsPage = lazy(() => import("@/pages/HourlyRentalsPage"));
const HourlyBookingPage = lazy(() => import("@/pages/HourlyBookingPage"));
const BoardingPassEkeyPage = lazy(() => import("@/pages/BoardingPassEkeyPage"));
const UnlockQrPage = lazy(() => import("@/pages/UnlockQrPage"));
const RatingPage = lazy(() => import("@/pages/RatingPage"));
const VendorPage = lazy(() => import("@/pages/VendorPage"));
const QuickSetupPage = lazy(() => import("@/pages/QuickSetupPage"));
const CheckInPage = lazy(() => import("@/pages/CheckInPage"));
const LoginPage = lazy(() => import("@/pages/LoginPage"));
const PinCheckinPage = lazy(() => import("@/pages/PinCheckinPage"));
const FindReservationPage = lazy(() => import("@/pages/FindReservationPage"));
const InfoScreenPage = lazy(() => import("@/pages/InfoScreenPage"));
const GuestExtrasPage = lazy(() => import("@/pages/GuestExtrasPage"));
const MarketingPage = lazy(() => import("@/pages/MarketingPage"));
const AccountingDocsPage = lazy(() => import("@/pages/AccountingDocsPage"));
const ManualPage = lazy(() => import("@/pages/ManualPage"));
const NotFound = lazy(() => import("@/pages/not-found"));

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const [location, setLocation] = useLocation();
  const [status, setStatus] = useState<"loading" | "authenticated" | "unauthenticated">("loading");
  
  useEffect(() => {
    const validateSession = async () => {
      const token = localStorage.getItem("auth_token");
      if (!token) {
        setStatus("unauthenticated");
        setLocation("/login");
        return;
      }
      
      try {
        const res = await fetch("/api/auth/session", {
          headers: { Authorization: `Bearer ${token}` },
        });
        
        if (res.ok) {
          const data = await res.json();
          localStorage.setItem("hotel_user", JSON.stringify(data.user));
          localStorage.setItem("hotel_info", JSON.stringify(data.hotel));
          setStatus("authenticated");
        } else {
          localStorage.removeItem("auth_token");
          localStorage.removeItem("hotel_user");
          localStorage.removeItem("hotel_info");
          setStatus("unauthenticated");
          setLocation("/login");
        }
      } catch {
        setStatus("unauthenticated");
        setLocation("/login");
      }
    };
    
    validateSession();
  }, [setLocation]);
  
  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="text-slate-400">Loading...</div>
      </div>
    );
  }
  
  if (status !== "authenticated") {
    return null;
  }
  
  return <Component />;
}

function Router() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-background">
          <div className="w-6 h-6 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" />
        </div>
      }
    >
    <Switch>
      <Route path="/login" component={LoginPage} />
      <Route path="/boarding-pass" component={BoardingPassEkeyPage} />
      <Route path="/unlock-qr" component={UnlockQrPage} />
      <Route path="/rate" component={RatingPage} />
      <Route path="/setup" component={QuickSetupPage} />
      <Route path="/check-in/:token" component={CheckInPage} />
      <Route path="/checkin/:hotel/:token" component={CheckInPage} />
      <Route path="/:hotel/checkin" component={PinCheckinPage} />
      <Route path="/:hotel/find" component={FindReservationPage} />
      <Route path="/:hotel/hourly" component={HourlyBookingPage} />
      <Route path="/:hotel/info" component={InfoScreenPage} />
      <Route path="/:hotel/extend" component={GuestExtrasPage} />
      <Route path="/:hotel/extras" component={GuestExtrasPage} />
      <Route path="/:hotel/guide" component={InfoScreenPage} />
      <Route path="/vendor" component={VendorPage} />
      <Route path="/">
        <ProtectedRoute component={LockDevicesPage} />
      </Route>
      <Route path="/reservations">
        <ProtectedRoute component={ReservationsPage} />
      </Route>
      {/* No-login share link from the report/reminder mails — long secret token,
          rendered without the admin menu (mobile-friendly, noindex). */}
      <Route path="/arrivals/t/:token" component={ArrivalsPage} />
      <Route path="/arrivals">
        <ProtectedRoute component={ArrivalsPage} />
      </Route>
      <Route path="/spaces">
        <ProtectedRoute component={SpacesPage} />
      </Route>
      <Route path="/spaces/:id">
        <ProtectedRoute component={SpacesPage} />
      </Route>
      <Route path="/lock-mapping">
        <ProtectedRoute component={LockMappingPage} />
      </Route>
      <Route path="/hourly">
        <ProtectedRoute component={HourlyRentalsPage} />
      </Route>
      <Route path="/marketing">
        <ProtectedRoute component={MarketingPage} />
      </Route>
      <Route path="/accounting">
        <ProtectedRoute component={AccountingDocsPage} />
      </Route>
      <Route path="/manual/:topic">
        <ProtectedRoute component={ManualPage} />
      </Route>
      <Route path="/manual">
        <ProtectedRoute component={ManualPage} />
      </Route>
      <Route path="/logs">
        <ProtectedRoute component={LogsPage} />
      </Route>
      <Route path="/settings">
        <ProtectedRoute component={SettingsPage} />
      </Route>
      <Route component={NotFound} />
    </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
