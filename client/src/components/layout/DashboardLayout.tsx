import React from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { LogOut, CalendarDays, Lock, Key, Boxes, Link2, UserCheck, Settings, Clock, Megaphone, BookOpenText, LifeBuoy } from "lucide-react";
import { MANUAL_TOPICS } from "@/lib/manual-topics";
import { cn } from "@/lib/utils";
import { logout, getAuthUser, getHotelInfo } from "@/lib/auth";
import { settingsAPI } from "@/lib/api";

export function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const user = getAuthUser();
  const hotel = getHotelInfo();

  // Hourly rentals are opt-in per tenant — hide the nav item unless enabled.
  const { data: hourlySetting } = useQuery({
    queryKey: ["settings", "hourly_rentals_enabled"],
    queryFn: () => settingsAPI.getOne("hourly_rentals_enabled").catch(() => null),
  });
  const hourlyEnabled = hourlySetting?.value === "true";

  const handleLogout = () => {
    logout();
    setLocation("/login");
  };

  const navItems = [
    { icon: Lock, label: "Overview", href: "/" },
    { icon: UserCheck, label: "Arrivals", href: "/arrivals" },
    { icon: CalendarDays, label: "Reservations", href: "/reservations" },
    { icon: Boxes, label: "Spaces", href: "/spaces" },
    { icon: Link2, label: "Lock Mapping", href: "/lock-mapping" },
    ...(hourlyEnabled ? [{ icon: Clock, label: "Time Booking", href: "/hourly" }] : []),
    { icon: Megaphone, label: "Marketing", href: "/marketing" },
    // Bookkeeping docs cover the kiosk/hourly upsell products — same tenants
    // that have hourly rentals enabled (Capsule).
    ...(hourlyEnabled ? [{ icon: BookOpenText, label: "Bookkeeping", href: "/accounting" }] : []),
    { icon: LifeBuoy, label: "Vejledning", href: "/manual" },
    { icon: Settings, label: "Settings", href: "/settings" },
  ];

  // "Vejledning" expands into one sub-item per guide topic while the user is
  // inside the guide (hourly-only topics follow the Time Booking gate).
  const manualSubItems = MANUAL_TOPICS
    .filter(t => !t.hourlyOnly || hourlyEnabled)
    .map(t => ({ label: t.label, href: `/manual/${t.slug}` }));

  return (
    <div className="flex h-screen bg-background text-foreground font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-sidebar-border bg-sidebar text-sidebar-foreground flex flex-col">
        <div className="p-6 flex items-center gap-3 border-b border-sidebar-border/20">
          <div className="bg-primary/20 p-2 rounded-lg">
            <div className="w-6 h-6 bg-primary rounded-sm flex items-center justify-center text-primary-foreground font-bold text-xs">DB</div>
          </div>
          <div>
            <h1 className="font-bold text-lg tracking-tight">DreamBoks</h1>
            <p className="text-xs text-sidebar-foreground/60">Management Portal</p>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => {
            const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
            const isManual = item.href === "/manual";
            return (
              <div key={item.href}>
                <Link href={item.href}>
                  <div
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors cursor-pointer",
                      isActive
                        ? "bg-sidebar-primary text-sidebar-primary-foreground"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                    )}
                  >
                    <item.icon className="w-4 h-4" />
                    {item.label}
                  </div>
                </Link>
                {isManual && isActive && (
                  <div className="mt-1 space-y-0.5">
                    {manualSubItems.map((sub) => {
                      const subActive = location === sub.href ||
                        (sub.href === "/manual/overnatning" && location === "/manual");
                      return (
                        <Link key={sub.href} href={sub.href}>
                          <div
                            className={cn(
                              "pl-10 pr-3 py-2 rounded-md text-sm transition-colors cursor-pointer",
                              subActive
                                ? "text-sidebar-primary-foreground bg-sidebar-primary/60 font-medium"
                                : "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                            )}
                          >
                            {sub.label}
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="p-4 border-t border-sidebar-border/20">
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground cursor-pointer transition-colors"
            data-testid="button-logout"
          >
            <LogOut className="w-4 h-4" />
            Log out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden bg-muted/20">
        <header className="h-16 border-b bg-background flex items-center justify-between px-8">
          <div className="text-sm text-muted-foreground">
            {hotel && (
              <span className="font-medium text-foreground">{hotel.name}</span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right text-sm">
              <div className="font-medium text-foreground">{user?.name || "User"}</div>
              <div className="text-xs text-muted-foreground">{user?.email}</div>
            </div>
            <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-medium text-xs">
              {user?.name?.substring(0, 2).toUpperCase() || "U"}
            </div>
          </div>
        </header>
        <div className="flex-1 overflow-auto p-8">
          {children}
        </div>
      </main>
    </div>
  );
}
