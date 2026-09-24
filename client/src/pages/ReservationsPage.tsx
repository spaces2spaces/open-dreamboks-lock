import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Reservation, mockRooms, mockReservationLogs } from "@/lib/mockData";
import { reservationsAPI, fetchAPI } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Search, Filter, Link as LinkIcon, MoreHorizontal, UploadCloud, Calendar, RefreshCw, ExternalLink, Mail, MessageSquare, AlertCircle, CheckCircle2, Box, X, Key, Trash2, Send, Wand2 } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { getHotelInfo } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";

// Append the logged-in tenant's hotel slug so the public /boarding-pass page
// (which is not slug-scoped in its path) resolves to the correct hotel.
function boardingPassHref(resNum: string, lastName: string): string {
  const slug = getHotelInfo()?.slug;
  const base = `/boarding-pass?res=${encodeURIComponent(resNum)}&name=${encodeURIComponent(lastName)}`;
  return slug ? `${base}&hotel=${encodeURIComponent(slug)}` : base;
}

export default function ReservationsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: reservations = [], isLoading } = useQuery({
    queryKey: ["reservations", "active"],
    queryFn: () => fetchAPI("/reservations?filter=active"),
  });
  
  const [selectedResId, setSelectedResId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [showDetail, setShowDetail] = useState(false);

  const generatePasscodeMutation = useMutation({
    mutationFn: (reservationId: string) =>
      fetchAPI(`/automation/generate-passcode/${reservationId}`, { method: 'POST' }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      toast({
        title: "Passcode Generated",
        description: `Passcode ${data.passcode} has been created and sent to guest.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Generate Passcode",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deletePasscodeMutation = useMutation({
    mutationFn: (reservationId: string) =>
      fetchAPI(`/automation/delete-passcode/${reservationId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      toast({
        title: "Passcode Deleted",
        description: "Passcode has been removed from the lock.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Delete Passcode",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const retryMewsCheckinMutation = useMutation({
    mutationFn: (reservationId: string) =>
      fetchAPI(`/reservations/${reservationId}/retry-mews-checkin`, { method: 'POST' }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      toast({
        title: "MEWS Check-in Successful",
        description: "Reservation has been checked in on MEWS.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "MEWS Check-in Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const resendNotificationMutation = useMutation({
    mutationFn: (reservationId: string) =>
      fetchAPI(`/reservations/${reservationId}/resend-notification`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      toast({
        title: "Notification Sent",
        description: "Access code has been sent to the guest.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Send Notification",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const sendPreCheckinEmailMutation = useMutation({
    mutationFn: (reservationId: string) =>
      fetchAPI(`/reservations/${reservationId}/send-precheckin-email`, { method: 'POST' }),
    onSuccess: (data: any) => {
      toast({ title: "Pre-check-in email sent", description: data.message });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to send pre-check-in email", description: error.message, variant: "destructive" });
    },
  });

  const sendBoardingPassMutation = useMutation({
    mutationFn: (reservationId: string) =>
      fetchAPI(`/reservations/${reservationId}/send-boarding-pass`, { method: 'POST' }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      const channels = data.channels || "all channels";
      toast({
        title: "Boarding Pass Sent",
        description: `Sent via ${channels}`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to Send Boarding Pass",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const refreshPinMutation = useMutation({
    mutationFn: (reservationId: string) =>
      fetchAPI(`/reservations/${reservationId}/refresh-pin`, { method: 'POST' }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      if (data.success) {
        toast({ title: "PIN opdateret i TTLock" });
      } else {
        toast({ title: data.error || "PIN kunne ikke opdateres", variant: "destructive" });
      }
    },
    onError: () => {
      toast({ title: "PIN-opdatering fejlede", variant: "destructive" });
    },
  });

  const refreshBalanceMutation = useMutation({
    mutationFn: (reservationId: string) =>
      fetchAPI(`/reservations/${reservationId}/refresh-balance`, { method: 'POST' }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      const amount = parseFloat(data.owing || "0").toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const fromBill = data.source === "customer-bill";
      toast({
        title: `Balance: ${amount} kr`,
        description: fromBill ? "Hentet fra MEWS kundekonto" : "Beregnet fra ordrelinjer",
      });
    },
    onError: () => {
      toast({ title: "Kunne ikke opdatere balance", variant: "destructive" });
    },
  });

  const backfillPinsMutation = useMutation({
    mutationFn: () =>
      fetchAPI(`/reservations/backfill-pins`, { method: 'POST' }),
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      toast({
        title: "PIN backfill kørt",
        description: `${data.processed} oprettet, ${data.skipped} sprunget over, ${data.failed} fejlede (af ${data.total} fremtidige)`,
      });
    },
    onError: (error: Error) => {
      toast({ title: "Backfill fejlede", description: error.message, variant: "destructive" });
    },
  });

  useEffect(() => {
    if (reservations.length > 0 && !selectedResId) {
      setSelectedResId(reservations[0].id);
    }
  }, [reservations, selectedResId]);

  const filteredReservations = reservations.filter((r: Reservation) => 
    (r.email?.toLowerCase() || '').includes(searchTerm.toLowerCase()) || 
    (r.firstName?.toLowerCase() || '').includes(searchTerm.toLowerCase()) ||
    (r.lastName?.toLowerCase() || '').includes(searchTerm.toLowerCase())
  );

  const selectedRes = reservations.find((r: Reservation) => r.id === selectedResId);

  const getInitials = (firstName: string, lastName: string) => {
    return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
  };

  const getAvatarColor = (name: string) => {
    return "bg-primary";
  };

  const handleResClick = (id: string) => {
    setSelectedResId(id);
    setShowDetail(true);
  };

  return (
    <DashboardLayout>
      {/* Main Content */}
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between mb-6">
            <h1 className="text-3xl font-bold tracking-tight">Reservations</h1>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="gap-2"
                onClick={() => backfillPinsMutation.mutate()}
                disabled={backfillPinsMutation.isPending}
                title="Genererer PIN for alle fremtidige reservationer der mangler en"
              >
                <Wand2 className="w-4 h-4" />
                {backfillPinsMutation.isPending ? "Backfiller PINs..." : "Backfill PINs"}
              </Button>
              <Button variant="ghost" className="text-primary gap-2 hover:text-primary/80">
                <UploadCloud className="w-4 h-4" />
                Upload your reservations
              </Button>
            </div>
        </div>

        <div className="flex gap-6 h-full">
            {/* List Column */}
            <div className={cn("flex flex-col gap-4 transition-all duration-300", showDetail ? "w-1/3 min-w-[350px]" : "w-full")}>
            <div className="flex items-center gap-2">
                <div className="relative flex-1">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                    placeholder="Type to create or search ..."
                    className="pl-9 bg-background border-muted-foreground/20"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                />
                </div>
                <Button variant="outline" className="gap-2 border-muted-foreground/20">
                <Filter className="w-4 h-4" />
                Filter
                </Button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-2">
                {isLoading ? (
                  <div className="text-center text-muted-foreground py-8">Loading reservations...</div>
                ) : filteredReservations.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8">No reservations found</div>
                ) : (
                  filteredReservations.map((res: Reservation) => (
                <Card 
                    key={res.id}
                    onClick={() => handleResClick(res.id)}
                    className={cn(
                    "cursor-pointer transition-all border shadow-sm hover:shadow-md",
                    selectedResId === res.id && showDetail ? "border-l-4 border-l-primary border-r-transparent border-t-transparent border-b-transparent bg-background" : "border-transparent bg-card hover:border-border"
                    )}
                >
                    <CardContent className="p-4 flex items-start gap-4">
                    <div className={cn("w-10 h-10 rounded-full flex items-center justify-center text-white font-bold shrink-0 mt-1", getAvatarColor(res.firstName))}>
                        {getInitials(res.firstName, res.lastName)}
                    </div>
                    <div className="flex-1 min-w-0">
                        {(() => {
                          const resNum = res.confirmationCode || res.extId;
                          const lastName = res.lastName;
                          const canOpen = !!resNum && !!lastName;
                          const href = canOpen
                            ? boardingPassHref(resNum!, lastName!)
                            : undefined;
                          return canOpen ? (
                            <div className="flex justify-end mb-1">
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                title="Open guest boarding pass"
                              >
                                <ExternalLink className="w-3 h-3" />
                                Boarding Pass
                              </a>
                            </div>
                          ) : null;
                        })()}
                        <div className="font-bold text-base truncate">{res.email}</div>
                        <div className="text-muted-foreground text-sm truncate mb-1">
                        {res.firstName} {res.lastName}
                        </div>
                        <div className="flex items-center justify-between text-xs text-muted-foreground mt-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground/80">{format(new Date(res.arrival), "d MMM")}</span>
                            <span className="text-primary font-bold">○-●</span>
                            <span className="font-medium text-foreground/80">{format(new Date(res.departure), "d MMM")}</span>
                          </div>
                          <span className="font-mono text-muted-foreground">{res.confirmationCode || res.extId}</span>
                        </div>
                        {res.owing !== null && res.owing !== undefined && (
                          <div className="mt-1.5 flex justify-end">
                            <span className={cn(
                              "text-xs font-semibold px-2 py-0.5 rounded-full",
                              parseFloat(res.owing) > 0 && res.preCheckinStatus !== "paid"
                                ? "bg-red-100 text-red-700"
                                : "bg-blue-50 text-[#5b8fa8]"
                            )}>
                              {parseFloat(res.owing).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {res.currency || 'kr'}
                            </span>
                          </div>
                        )}
                        
                        {res.status === "Canceled" && (
                        <div className="mt-2">
                            <Badge variant="secondary" className="bg-muted text-muted-foreground hover:bg-muted">Canceled</Badge>
                        </div>
                        )}
                    </div>
                    </CardContent>
                </Card>
                  ))
                )}
            </div>
            </div>

            {/* Detail View Overlay/Panel */}
            {showDetail && selectedRes && (
                <div className="flex-1 bg-background border rounded-xl shadow-sm overflow-hidden flex flex-col animate-in slide-in-from-right-5 duration-300">
                     <div className="p-6 border-b flex items-start justify-between bg-muted/10">
                        <div className="flex flex-col gap-1">
                            <h2 className="text-2xl font-bold">{selectedRes.firstName} {selectedRes.lastName}</h2>
                            <p className="text-muted-foreground">{selectedRes.email}</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowDetail(false)}>
                                <X className="h-4 w-4" />
                            </Button>
                        </div>
                     </div>

                     <div className="flex-1 overflow-y-auto p-6">
                        <div className="max-w-md mx-auto">
                            {/* Reservation Details */}
                            <div className="space-y-4">
                                <div>
                                    <Label className="text-xs text-muted-foreground uppercase tracking-wider">Reservation Date</Label>
                                    <div className="font-medium text-sm mt-1">
                                        {format(new Date(selectedRes.arrival), "d MMM")} → {format(new Date(selectedRes.departure), "d MMM")}
                                    </div>
                                </div>

                                <div>
                                    <Label className="text-xs text-muted-foreground uppercase tracking-wider">PMS State</Label>
                                    <div className="mt-1 flex items-center gap-2">
                                        <Badge 
                                            variant={
                                                selectedRes.status === "Checked-in" ? "default" : 
                                                selectedRes.status === "Canceled" ? "secondary" : 
                                                "outline"
                                            }
                                            className={
                                                selectedRes.status === "Canceled" ? "bg-muted text-muted-foreground hover:bg-muted" : ""
                                            }
                                        >
                                            {selectedRes.status}
                                        </Badge>
                                        {selectedRes.status === "Checked-in" && selectedRes.pmsCheckinSource && (
                                            <span className="text-xs text-muted-foreground">
                                                via {selectedRes.pmsCheckinSource === "lock" ? "Smart Lock" : 
                                                     selectedRes.pmsCheckinSource === "manual" ? "Manual" : 
                                                     selectedRes.pmsCheckinSource}
                                            </span>
                                        )}
                                    </div>
                                </div>

                                {selectedRes.preCheckinStatus && selectedRes.preCheckinStatus !== "pending" && (
                                <div>
                                    <Label className="text-xs text-muted-foreground uppercase tracking-wider">Online Check-in</Label>
                                    <div className="mt-1 flex items-center gap-2">
                                        <Badge 
                                            variant={
                                                selectedRes.preCheckinStatus === "code_sent" ? "default" : 
                                                selectedRes.preCheckinStatus === "mews_sync_failed" ? "destructive" : 
                                                selectedRes.preCheckinStatus === "notification_failed" ? "destructive" :
                                                selectedRes.preCheckinStatus === "mews_checked_in" ? "secondary" :
                                                selectedRes.preCheckinStatus === "paid" ? "default" :
                                                "outline"
                                            }
                                        >
                                            {selectedRes.preCheckinStatus === "code_sent" ? "Code Sent" : 
                                             selectedRes.preCheckinStatus === "mews_sync_failed" ? "MEWS Sync Failed" :
                                             selectedRes.preCheckinStatus === "notification_failed" ? "Notification Failed" :
                                             selectedRes.preCheckinStatus === "mews_checked_in" ? "MEWS OK - Sending Code..." :
                                             selectedRes.preCheckinStatus === "paid" ? "Paid" :
                                             selectedRes.preCheckinStatus === "awaiting_payment" ? "Awaiting Payment" :
                                             selectedRes.preCheckinStatus}
                                        </Badge>
                                        {selectedRes.preCheckinStatus === "mews_sync_failed" && (
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => retryMewsCheckinMutation.mutate(selectedRes.id)}
                                                disabled={retryMewsCheckinMutation.isPending}
                                            >
                                                <RefreshCw className={cn("h-3 w-3 mr-1", retryMewsCheckinMutation.isPending && "animate-spin")} />
                                                Retry MEWS
                                            </Button>
                                        )}
                                        {(selectedRes.preCheckinStatus === "notification_failed" || selectedRes.preCheckinStatus === "mews_checked_in") && (
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                onClick={() => resendNotificationMutation.mutate(selectedRes.id)}
                                                disabled={resendNotificationMutation.isPending}
                                            >
                                                <RefreshCw className={cn("h-3 w-3 mr-1", resendNotificationMutation.isPending && "animate-spin")} />
                                                Resend Code
                                            </Button>
                                        )}
                                    </div>
                                </div>
                                )}

                                <div>
                                    <Label className="text-xs text-muted-foreground uppercase tracking-wider">Confirmation number</Label>
                                    <div className="font-medium text-sm mt-1">
                                        {selectedRes.confirmationCode || selectedRes.extId || "-"}
                                    </div>
                                </div>

                                <div>
                                    <Label className="text-xs text-muted-foreground uppercase tracking-wider">Group name</Label>
                                    <div className="font-medium text-sm mt-1">
                                        {selectedRes.groupName || "-"}
                                    </div>
                                </div>

                                <div>
                                    <Label className="text-xs text-muted-foreground uppercase tracking-wider">Companions</Label>
                                    <div className="font-medium text-sm mt-1">{selectedRes.adults} × Adults</div>
                                </div>

                                <div>
                                    <Label className="text-xs text-muted-foreground uppercase tracking-wider">Assigned space</Label>
                                    <div className="font-medium text-sm mt-1">{selectedRes.assignedSpace && selectedRes.roomLabel ? `${selectedRes.assignedSpace} ${selectedRes.roomLabel}` : selectedRes.assignedSpace || (selectedRes.room && selectedRes.bed ? `${selectedRes.room} - ${selectedRes.bed}` : selectedRes.room) || "-"}</div>
                                </div>

                                <div className="pt-4 border-t">
                                    <Label className="text-xs text-primary font-medium uppercase tracking-wider mb-3 block">Billing</Label>
                                    <div className="space-y-4">
                                        <div className="font-medium">{selectedRes.firstName} {selectedRes.lastName}</div>

                                        <div className={cn(
                                            "flex items-center justify-between rounded-lg px-3 py-2",
                                            parseFloat(selectedRes.owing || "0") > 0 && selectedRes.preCheckinStatus !== "paid"
                                                ? "bg-red-50 border border-red-200"
                                                : "bg-blue-50 border border-blue-200"
                                        )}>
                                            <Label className="text-xs font-semibold uppercase tracking-wider">Balance</Label>
                                            <div className="flex items-center gap-2">
                                                <span className={cn(
                                                    "font-bold text-sm",
                                                    parseFloat(selectedRes.owing || "0") > 0 && selectedRes.preCheckinStatus !== "paid"
                                                        ? "text-red-600"
                                                        : "text-[#5b8fa8]"
                                                )}>
                                                    {`${parseFloat(selectedRes.owing || "0").toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${selectedRes.currency || 'kr'}`}
                                                </span>
                                                <button
                                                    onClick={() => refreshBalanceMutation.mutate(selectedRes.id)}
                                                    disabled={refreshBalanceMutation.isPending}
                                                    title="Refresh balance from MEWS"
                                                    className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                                                >
                                                    <RefreshCw className={cn("h-3 w-3", refreshBalanceMutation.isPending && "animate-spin")} />
                                                </button>
                                            </div>
                                        </div>

                                        <div>
                                            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Avg. rate (nightly)</Label>
                                            <div className="font-medium text-sm mt-1">
                                                {selectedRes.avgRate ? `${parseFloat(selectedRes.avgRate).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${selectedRes.currency || 'kr'}` : "-"}
                                            </div>
                                        </div>

                                        <div>
                                            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Avg. price with products (nightly)</Label>
                                            <div className="font-medium text-sm mt-1">
                                                {selectedRes.avgRate ? `${parseFloat(selectedRes.avgRate).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${selectedRes.currency || 'kr'}` : "-"}
                                            </div>
                                        </div>

                                        <div>
                                            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Total amount</Label>
                                            <div className="font-medium text-sm mt-1">
                                                {selectedRes.totalAmount ? `${parseFloat(selectedRes.totalAmount).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${selectedRes.currency || 'kr'}` : "-"}
                                            </div>
                                        </div>

                                        <div>
                                            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Requested category</Label>
                                            <div className="font-medium text-sm mt-1">{selectedRes.requestedCategory || "-"}</div>
                                        </div>

                                        <div>
                                            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Space category</Label>
                                            <div className="font-medium text-sm mt-1">{selectedRes.spaceCategory || "-"}</div>
                                        </div>

                                        <div>
                                            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Rate</Label>
                                            <div className="font-medium text-sm mt-1">{selectedRes.rateName || "-"}</div>
                                        </div>

                                        <div>
                                            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Origin</Label>
                                            <div className="font-medium text-sm mt-1">{selectedRes.origin || "-"}</div>
                                        </div>

                                        <div>
                                            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Reservation source</Label>
                                            <div className="font-medium text-sm mt-1">{selectedRes.reservationSource || "Message"}</div>
                                        </div>
                                    </div>
                                </div>

                                <div className="pt-4 border-t">
                                    <Label className="text-xs text-primary font-medium uppercase tracking-wider mb-3 block">Access Code</Label>
                                    <Card className="bg-muted/5">
                                        <CardContent className="p-4">
                                            {selectedRes.generatedPin ? (
                                                <div className="space-y-3">
                                                    <div className="flex items-center justify-between">
                                                        <div>
                                                            <Label className="text-xs text-muted-foreground">Passcode</Label>
                                                            <div className="text-2xl font-bold font-mono tracking-wider text-primary">
                                                                {selectedRes.generatedPin}
                                                            </div>
                                                        </div>
                                                        <div className="flex items-center gap-2">
                                                            <button
                                                                onClick={() => refreshPinMutation.mutate(selectedRes.id)}
                                                                disabled={refreshPinMutation.isPending}
                                                                title="Sync PIN validity to TTLock"
                                                                className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                                                            >
                                                                <RefreshCw className={cn("h-4 w-4", refreshPinMutation.isPending && "animate-spin")} />
                                                            </button>
                                                            <Key className="w-8 h-8 text-muted-foreground/30" />
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <Label className="text-xs text-muted-foreground">Status:</Label>
                                                        {(() => {
                                                            const isUsed = selectedRes.pinStatus === "used" || selectedRes.pinFirstUsedAt;
                                                            const isExpired = !isUsed && new Date(selectedRes.departure) < new Date();
                                                            const isPending = selectedRes.pinStatus === "pending";
                                                            const isActive = selectedRes.pinStatus === "active";
                                                            
                                                            return (
                                                                <Badge 
                                                                    variant={
                                                                        isUsed ? "default" :
                                                                        isExpired ? "destructive" :
                                                                        isActive ? "secondary" :
                                                                        "outline"
                                                                    }
                                                                    className={
                                                                        isUsed ? "bg-green-500 hover:bg-green-600 text-white" :
                                                                        isExpired ? "bg-red-500 text-white" :
                                                                        isActive ? "bg-yellow-100 text-yellow-800 border-yellow-300" :
                                                                        "bg-gray-100 text-gray-600 border-gray-300"
                                                                    }
                                                                    data-testid="badge-pin-status"
                                                                >
                                                                    {isUsed ? "Used" :
                                                                     isExpired ? "Expired" :
                                                                     isPending ? "Pending Activation" :
                                                                     isActive ? "Active" :
                                                                     selectedRes.pinStatus || "Unknown"}
                                                                </Badge>
                                                            );
                                                        })()}
                                                    </div>
                                                    {selectedRes.pinFirstUsedAt && (
                                                        <div className="text-xs text-muted-foreground">
                                                            First used: {format(new Date(selectedRes.pinFirstUsedAt), "d MMM yyyy, HH:mm")}
                                                        </div>
                                                    )}
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        className="w-full gap-2"
                                                        onClick={() => sendPreCheckinEmailMutation.mutate(selectedRes.id)}
                                                        disabled={sendPreCheckinEmailMutation.isPending}
                                                    >
                                                        <Mail className="w-4 h-4" />
                                                        {sendPreCheckinEmailMutation.isPending ? "Sending..." : "Pre-check-in Email"}
                                                    </Button>
                                                    {(() => {
                                                        const resNum = selectedRes.confirmationCode || selectedRes.extId;
                                                        const lastName = selectedRes.lastName;
                                                        if (!resNum || !lastName) return null;
                                                        const href = boardingPassHref(resNum, lastName);
                                                        return (
                                                            <Button
                                                                variant="outline"
                                                                size="sm"
                                                                className="w-full gap-2"
                                                                asChild
                                                            >
                                                                <a href={href} target="_blank" rel="noopener noreferrer">
                                                                    <ExternalLink className="w-4 h-4" />
                                                                    Open Boarding Pass
                                                                </a>
                                                            </Button>
                                                        );
                                                    })()}
                                                    <Button
                                                        variant="default"
                                                        size="sm"
                                                        className="w-full gap-2"
                                                        onClick={() => sendBoardingPassMutation.mutate(selectedRes.id)}
                                                        disabled={sendBoardingPassMutation.isPending}
                                                    >
                                                        <Send className="w-4 h-4" />
                                                        {sendBoardingPassMutation.isPending ? "Sending..." : "Send Boarding Pass"}
                                                    </Button>
                                                    <Button
                                                        variant="destructive"
                                                        size="sm"
                                                        className="w-full gap-2"
                                                        onClick={() => deletePasscodeMutation.mutate(selectedRes.id)}
                                                        disabled={deletePasscodeMutation.isPending}
                                                        data-testid="button-delete-passcode"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                        {deletePasscodeMutation.isPending ? "Deleting..." : "Delete Passcode"}
                                                    </Button>
                                                </div>
                                            ) : (
                                                <div className="space-y-3">
                                                    <div className="flex items-center gap-2 text-muted-foreground">
                                                        <AlertCircle className="w-4 h-4" />
                                                        <span className="text-sm">No passcode generated yet</span>
                                                    </div>
                                                    <Button
                                                        variant="default"
                                                        size="sm"
                                                        className="w-full gap-2"
                                                        onClick={() => generatePasscodeMutation.mutate(selectedRes.id)}
                                                        disabled={generatePasscodeMutation.isPending || selectedRes.status !== "Checked-in"}
                                                        data-testid="button-generate-passcode"
                                                    >
                                                        <Key className="w-4 h-4" />
                                                        {generatePasscodeMutation.isPending ? "Generating..." : "Generate Passcode"}
                                                    </Button>
                                                    {selectedRes.status !== "Checked-in" && (
                                                        <p className="text-xs text-muted-foreground text-center">
                                                            Guest must be checked-in to generate passcode
                                                        </p>
                                                    )}
                                                </div>
                                            )}
                                        </CardContent>
                                    </Card>
                                </div>

                            </div>
                        </div>
                     </div>
                </div>
            )}
        </div>
      </div>
    </DashboardLayout>
  );
}
