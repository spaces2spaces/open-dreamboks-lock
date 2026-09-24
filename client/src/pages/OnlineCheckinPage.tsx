import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getAuthHeaders } from "@/lib/auth";
import { format } from "date-fns";
import { 
  Copy, 
  ExternalLink, 
  Search, 
  UserCheck, 
  Clock, 
  CreditCard,
  CheckCircle2,
  Mail,
  Send,
  Phone,
  MessageSquare,
  RefreshCw
} from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface Reservation {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  mobile: string | null;
  arrival: string;
  departure: string;
  status: string;
  room: string | null;
  preCheckinToken: string | null;
  preCheckinStatus: string | null;
  codeDeliveredAt: string | null;
  generatedPin: string | null;
  preCheckinEmailSent: boolean | null;
}

export default function OnlineCheckinPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");
  const [sendingEmail, setSendingEmail] = useState<string | null>(null);
  const [sendingSms, setSendingSms] = useState<string | null>(null);
  const [resendingBoardingPass, setResendingBoardingPass] = useState<string | null>(null);

  const { data: reservations, isLoading } = useQuery<Reservation[]>({
    queryKey: ["/api/reservations?filter=checkin"],
  });

  const upcomingReservations = reservations?.filter(r => {
    const arrival = new Date(r.arrival);
    const now = new Date();
    const daysDiff = (arrival.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return daysDiff >= -1 && daysDiff <= 7 && 
      r.status !== "Cancelled" && 
      r.status !== "Checked-out" && 
      r.status !== "Checked-in";
  }) || [];

  const filteredReservations = upcomingReservations.filter(r => {
    const searchLower = searchTerm.toLowerCase();
    return (
      r.firstName.toLowerCase().includes(searchLower) ||
      r.lastName.toLowerCase().includes(searchLower) ||
      r.email?.toLowerCase().includes(searchLower) ||
      r.room?.toLowerCase().includes(searchLower)
    );
  });

  const getCheckInUrl = (token: string) => {
    return `${window.location.origin}/check-in/${token}`;
  };

  const copyCheckInLink = (token: string) => {
    navigator.clipboard.writeText(getCheckInUrl(token));
    toast({
      title: "Link copied",
      description: "The check-in link has been copied to your clipboard",
    });
  };

  const sendCheckInEmail = async (reservation: Reservation) => {
    if (!reservation.email) return;
    
    // Check if reservation has a PIN (new flow) or token (legacy flow)
    if (!reservation.generatedPin && !reservation.preCheckinToken) {
      toast({
        title: "No PIN available",
        description: "This reservation doesn't have a PIN code yet.",
        variant: "destructive",
      });
      return;
    }
    
    setSendingEmail(reservation.id);
    try {
      // Use the new PIN-based pre-check-in email endpoint
      const response = await fetch(`/api/reservations/${reservation.id}/send-precheckin-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      });

      const data = await response.json();
      
      if (response.ok) {
        toast({
          title: "Email sent",
          description: `Pre-check-in email sent to ${reservation.email}`,
        });
        // Refresh the reservations list to update the status
        queryClient.invalidateQueries({ queryKey: ["/api/reservations"] });
      } else {
        throw new Error(data.error || "Failed to send email");
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Could not send email. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSendingEmail(null);
    }
  };

  const sendCheckInSms = async (reservation: Reservation) => {
    if (!reservation.mobile) return;
    
    if (!reservation.generatedPin && !reservation.preCheckinToken) {
      toast({
        title: "No PIN available",
        description: "This reservation doesn't have a PIN code yet.",
        variant: "destructive",
      });
      return;
    }
    
    setSendingSms(reservation.id);
    try {
      const response = await fetch(`/api/reservations/${reservation.id}/send-precheckin-sms`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      });

      const data = await response.json();
      
      if (response.ok) {
        toast({
          title: "SMS/WhatsApp sent",
          description: data.message || `Sent to ${reservation.mobile}`,
        });
        queryClient.invalidateQueries({ queryKey: ["/api/reservations"] });
      } else {
        throw new Error(data.error || "Failed to send SMS");
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Could not send SMS. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSendingSms(null);
    }
  };

  const resendBoardingPass = async (reservation: Reservation) => {
    if (!reservation.generatedPin) return;
    
    setResendingBoardingPass(reservation.id);
    try {
      const response = await fetch(`/api/reservations/${reservation.id}/resend-notification`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      });

      const data = await response.json();
      
      if (response.ok) {
        toast({
          title: "Digital key sent",
          description: "Digital key sent via email + SMS",
        });
        queryClient.invalidateQueries({ queryKey: ["/api/reservations"] });
      } else {
        throw new Error(data.error || "Failed to send digital key");
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Could not send digital key.",
        variant: "destructive",
      });
    } finally {
      setResendingBoardingPass(null);
    }
  };

  const getStatusBadge = (reservation: Reservation) => {
    if (reservation.codeDeliveredAt) {
      return <Badge className="bg-green-100 text-green-800" data-testid={`status-delivered-${reservation.id}`}><CheckCircle2 className="w-3 h-3 mr-1" />Digital key sent</Badge>;
    }
    if (reservation.preCheckinEmailSent) {
      return <Badge className="bg-green-100 text-green-800" data-testid={`status-email-sent-${reservation.id}`}><Send className="w-3 h-3 mr-1" />Pre-check-in sent</Badge>;
    }
    if (reservation.preCheckinStatus === "paid") {
      return <Badge className="bg-blue-100 text-blue-800" data-testid={`status-paid-${reservation.id}`}><CreditCard className="w-3 h-3 mr-1" />Paid</Badge>;
    }
    if (reservation.preCheckinStatus === "awaiting_payment") {
      return <Badge className="bg-yellow-100 text-yellow-800" data-testid={`status-awaiting-${reservation.id}`}><Clock className="w-3 h-3 mr-1" />Awaiting payment</Badge>;
    }
    return <Badge variant="outline" data-testid={`status-pending-${reservation.id}`}>Pending check-in</Badge>;
  };

  const isWithin24Hours = (arrival: string) => {
    const arrivalDate = new Date(arrival);
    const now = new Date();
    const hoursDiff = (arrivalDate.getTime() - now.getTime()) / (1000 * 60 * 60);
    return hoursDiff <= 24 && hoursDiff >= -24;
  };

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground" data-testid="page-title">Online Check-in</h1>
            <p className="text-muted-foreground">Send check-in links to guests before arrival</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserCheck className="w-5 h-5" />
              Upcoming Reservations
            </CardTitle>
            <CardDescription>
              Reservations arriving within the next 7 days. Guests can check in online 24 hours before arrival.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
                <Input
                  placeholder="Search by name, email or room..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10"
                  data-testid="input-search"
                />
              </div>
            </div>

            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">Loading reservations...</div>
            ) : filteredReservations.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No upcoming reservations found
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Guest</TableHead>
                    <TableHead>Room</TableHead>
                    <TableHead>Arrival</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Check-in</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredReservations.map((reservation) => (
                    <TableRow key={reservation.id} data-testid={`row-reservation-${reservation.id}`}>
                      <TableCell>
                        <div>
                          <div className="font-medium" data-testid={`text-guest-name-${reservation.id}`}>
                            {reservation.firstName} {reservation.lastName}
                          </div>
                          <div className="text-sm text-muted-foreground flex items-center gap-1">
                            <Mail className="w-3 h-3" />
                            {reservation.email || "No email"}
                          </div>
                          {reservation.mobile && (
                            <div className="text-sm text-muted-foreground flex items-center gap-1">
                              <Phone className="w-3 h-3" />
                              {reservation.mobile}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell data-testid={`text-room-${reservation.id}`}>
                        {reservation.room || "-"}
                      </TableCell>
                      <TableCell>
                        <div>
                          <div data-testid={`text-arrival-${reservation.id}`}>
                            {format(new Date(reservation.arrival), "dd/MM/yyyy")}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {format(new Date(reservation.arrival), "HH:mm")}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>{getStatusBadge(reservation)}</TableCell>
                      <TableCell>
                        {isWithin24Hours(reservation.arrival) ? (
                          <Badge className="bg-green-100 text-green-800">Open for check-in</Badge>
                        ) : (
                          <Badge variant="outline">Opens {format(new Date(new Date(reservation.arrival).getTime() - 24 * 60 * 60 * 1000), "dd/MM HH:mm")}</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          {reservation.preCheckinToken && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => copyCheckInLink(reservation.preCheckinToken!)}
                                data-testid={`button-copy-link-${reservation.id}`}
                              >
                                <Copy className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => window.open(getCheckInUrl(reservation.preCheckinToken!), "_blank")}
                                data-testid={`button-open-link-${reservation.id}`}
                              >
                                <ExternalLink className="w-4 h-4" />
                              </Button>
                            </>
                          )}
                          {reservation.email && reservation.generatedPin && (
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => sendCheckInEmail(reservation)}
                              disabled={sendingEmail === reservation.id}
                              title={`Send email to ${reservation.email}`}
                              data-testid={`button-send-email-${reservation.id}`}
                            >
                              <Mail className="w-4 h-4" />
                            </Button>
                          )}
                          {reservation.mobile && reservation.generatedPin && (
                            <Button
                              variant="default"
                              size="sm"
                              className="bg-green-600 hover:bg-green-700"
                              onClick={() => sendCheckInSms(reservation)}
                              disabled={sendingSms === reservation.id}
                              title={`Send SMS/WhatsApp to ${reservation.mobile}`}
                              data-testid={`button-send-sms-${reservation.id}`}
                            >
                              <MessageSquare className="w-4 h-4" />
                            </Button>
                          )}
                          {reservation.codeDeliveredAt && reservation.generatedPin && (
                            <Button
                              variant="default"
                              size="sm"
                              className="bg-blue-600 hover:bg-blue-700"
                              onClick={() => resendBoardingPass(reservation)}
                              disabled={resendingBoardingPass === reservation.id}
                              title="Resend digital key (email + SMS)"
                              data-testid={`button-resend-boarding-${reservation.id}`}
                            >
                              <RefreshCw className={`w-4 h-4 ${resendingBoardingPass === reservation.id ? "animate-spin" : ""}`} />
                            </Button>
                          )}
                          {!reservation.generatedPin && !reservation.preCheckinToken && (
                            <span className="text-sm text-muted-foreground">No PIN</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
