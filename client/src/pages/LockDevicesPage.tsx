import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Lock, CheckCircle2, XCircle, Building2, CalendarDays, Key, KeyRound, UserCheck, ClipboardCheck } from "lucide-react";
import { lockDevicesAPI, roomsAPI, roomLockAssignmentsAPI, reservationsAPI, pinsAPI } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

export default function LockDevicesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [editingDoorNames, setEditingDoorNames] = useState<Record<string, string>>({});

  const { data: lockDevices = [], isLoading } = useQuery({
    queryKey: ["lock-devices"],
    queryFn: lockDevicesAPI.getAll,
  });

  const { data: assignments = [] } = useQuery({
    queryKey: ["roomLockAssignments"],
    queryFn: roomLockAssignmentsAPI.getAll,
  });

  const { data: rooms = [] } = useQuery({
    queryKey: ["rooms"],
    queryFn: roomsAPI.getAll,
  });

  const { data: reservations = [] } = useQuery({
    queryKey: ["reservations"],
    queryFn: reservationsAPI.getAll,
  });

  const { data: pins = [] } = useQuery({
    queryKey: ["pins"],
    queryFn: pinsAPI.getAll,
  });

  const updateLockTypeMutation = useMutation({
    mutationFn: ({ id, lockType }: { id: string; lockType: "room" | "common" }) =>
      lockDevicesAPI.update(id, { lockType }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lock-devices"] });
      queryClient.invalidateQueries({ queryKey: ["lockDevices"] });
      toast({ title: "Lock type updated" });
    },
    onError: () => {
      toast({ title: "Failed to update lock type", variant: "destructive" });
    },
  });

  const updateDoorNameMutation = useMutation({
    mutationFn: ({ id, doorName }: { id: string; doorName: string }) =>
      lockDevicesAPI.update(id, { doorName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["lock-devices"] });
      queryClient.invalidateQueries({ queryKey: ["lockDevices"] });
      toast({ title: "Door name saved" });
    },
    onError: () => {
      toast({ title: "Failed to save door name", variant: "destructive" });
    },
  });

  const handleLockTypeChange = (deviceId: string, newType: "room" | "common") => {
    const deviceAssignments = assignments.filter((a: any) => a.lockDeviceId === deviceId);
    
    if (newType === "room" && deviceAssignments.length > 1) {
      toast({ 
        title: "Cannot change to Room Lock", 
        description: `This lock has ${deviceAssignments.length} spaces assigned. Remove assignments first (Room Lock can only have 1 space).`,
        variant: "destructive" 
      });
      return;
    }
    
    updateLockTypeMutation.mutate({ id: deviceId, lockType: newType });
  };

  const lockStats = useMemo(() => {
    const total = lockDevices.length;
    const mapped = lockDevices.filter((device: any) => 
      assignments.some((a: any) => a.lockDeviceId === device.id)
    ).length;
    const unmapped = total - mapped;
    
    // Unique rooms with lock assignments (Spaces med DreamBoks Lock)
    const uniqueRoomsWithLocks = new Set(assignments.map((a: any) => a.roomId)).size;
    
    // Pin stats - only count PINs associated with Room Locks (not Common Locks)
    // Get all Room Lock device IDs
    const roomLockDeviceIds = new Set(
      lockDevices
        .filter((d: any) => d.lockType === "room")
        .map((d: any) => d.id)
    );
    
    // Get rooms that have Room Lock assignments
    const roomsWithRoomLocks = new Set(
      assignments
        .filter((a: any) => roomLockDeviceIds.has(a.lockDeviceId))
        .map((a: any) => a.roomId)
    );
    
    // Filter PINs to only those associated with rooms that have Room Locks
    const pinsWithRoomLocks = pins.filter((p: any) => {
      // Check if PIN's room has a Room Lock assignment
      if (p.roomId && roomsWithRoomLocks.has(p.roomId)) {
        return true;
      }
      // Also check roomLockKeyIds for explicit Room Lock references
      if (p.roomLockKeyIds && Array.isArray(p.roomLockKeyIds)) {
        return p.roomLockKeyIds.some((entry: any) => 
          entry.lockDeviceId && roomLockDeviceIds.has(entry.lockDeviceId)
        );
      }
      return false;
    });
    
    const activePins = pinsWithRoomLocks.filter((p: any) => p.status === "active" && !p.firstUsedAt).length;
    const usedPins = pinsWithRoomLocks.filter((p: any) => p.status === "used" || p.firstUsedAt).length;
    
    // Pre-checked in (preCheckinStatus = code_sent, paid, etc - any non-pending status)
    const preCheckedIn = reservations.filter((r: any) => 
      r.preCheckinStatus && r.preCheckinStatus !== "pending"
    ).length;
    
    // PMS Checked in (status = Checked-in)
    const pmsCheckedIn = reservations.filter((r: any) => r.status === "Checked-in").length;
    
    return { total, mapped, unmapped, uniqueRoomsWithLocks, activePins, usedPins, preCheckedIn, pmsCheckedIn };
  }, [lockDevices, assignments, pins, reservations]);

  const locksWithAssignments = useMemo(() => {
    return lockDevices.map((device: any) => {
      const deviceAssignments = assignments.filter((a: any) => a.lockDeviceId === device.id);
      const assignedRooms = deviceAssignments.map((a: any) => {
        const room = rooms.find((r: any) => r.id === a.roomId);
        return room ? room.name : "Unknown";
      }).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      
      return {
        ...device,
        assignedCount: deviceAssignments.length,
        assignedRooms,
        isMapped: deviceAssignments.length > 0,
      };
    });
  }, [lockDevices, assignments, rooms]);

  const filteredLocks = useMemo(() => {
    return locksWithAssignments
      .filter((device: any) => {
        const matchesSearch = device.name.toLowerCase().includes(searchTerm.toLowerCase());
        const matchesStatus = 
          statusFilter === "all" || 
          (statusFilter === "mapped" && device.isMapped) ||
          (statusFilter === "unmapped" && !device.isMapped);
        return matchesSearch && matchesStatus;
      })
      .sort((a: any, b: any) => b.assignedCount - a.assignedCount);
  }, [locksWithAssignments, searchTerm, statusFilter]);

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center h-64">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Lock Overview</h1>
          <p className="text-muted-foreground">
            Overview of all locks and their assigned spaces
          </p>
        </div>

        <div className="grid grid-cols-5 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Building2 className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{lockStats.uniqueRoomsWithLocks}</p>
                  <p className="text-sm text-muted-foreground">Spaces with lock</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <Key className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{lockStats.activePins}</p>
                  <p className="text-sm text-muted-foreground">Active PINs</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-100 rounded-lg">
                  <KeyRound className="w-5 h-5 text-purple-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{lockStats.usedPins}</p>
                  <p className="text-sm text-muted-foreground">Used PINs</p>
                </div>
              </div>
            </CardContent>
          </Card>
          
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-orange-100 rounded-lg">
                  <UserCheck className="w-5 h-5 text-orange-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{lockStats.preCheckedIn}</p>
                  <p className="text-sm text-muted-foreground">Pre-checked in</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-teal-100 rounded-lg">
                  <ClipboardCheck className="w-5 h-5 text-teal-600" />
                </div>
                <div>
                  <p className="text-2xl font-bold" data-testid="text-pms-checkedin-count">{lockStats.pmsCheckedIn}</p>
                  <p className="text-sm text-muted-foreground">PMS Checked in</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between gap-4">
              <Input
                placeholder="Search locks..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="max-w-xs"
                data-testid="input-search-locks"
              />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-40" data-testid="select-status-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All locks</SelectItem>
                  <SelectItem value="mapped">Mapped only</SelectItem>
                  <SelectItem value="unmapped">Unmapped only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            {filteredLocks.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                {lockDevices.length === 0 
                  ? "No locks found. Sync locks on the Lock Mapping page."
                  : "No locks match your search."}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-3 font-medium text-muted-foreground">Status</th>
                      <th className="pb-3 font-medium text-muted-foreground">Lock</th>
                      <th className="pb-3 font-medium text-muted-foreground">Type</th>
                      <th className="pb-3 font-medium text-muted-foreground">Door Name</th>
                      <th className="pb-3 font-medium text-muted-foreground text-center">Spaces</th>
                      <th className="pb-3 font-medium text-muted-foreground">Assigned spaces</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filteredLocks.map((device: any) => (
                      <tr key={device.id} className="hover:bg-muted/30" data-testid={`lock-row-${device.id}`}>
                        <td className="py-4 pr-4">
                          {device.isMapped ? (
                            <div className="flex items-center gap-2">
                              <div className="w-2.5 h-2.5 rounded-full bg-green-500" />
                              <span className="text-sm text-green-700">Mapped</span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <div className="w-2.5 h-2.5 rounded-full bg-red-500" />
                              <span className="text-sm text-red-700">Unmapped</span>
                            </div>
                          )}
                        </td>
                        <td className="py-4 pr-4">
                          <div className="font-medium">{device.name}</div>
                        </td>
                        <td className="py-4 pr-4">
                          <Select
                            value={device.lockType || "room"}
                            onValueChange={(value: "room" | "common") =>
                              handleLockTypeChange(device.id, value)
                            }
                          >
                            <SelectTrigger className="w-32 h-8 text-xs" data-testid={`select-lock-type-${device.id}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="room">Room Lock</SelectItem>
                              <SelectItem value="common">Common Lock</SelectItem>
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="py-4 pr-4">
                          <Input
                            className="h-8 text-xs w-36"
                            placeholder="e.g. DreamBoks A3"
                            value={editingDoorNames[device.id] ?? device.doorName ?? ""}
                            onChange={(e) =>
                              setEditingDoorNames((prev) => ({ ...prev, [device.id]: e.target.value }))
                            }
                            onBlur={() => {
                              const val = editingDoorNames[device.id];
                              if (val === undefined) return;
                              if (val === (device.doorName ?? "")) return;
                              updateDoorNameMutation.mutate({ id: device.id, doorName: val });
                            }}
                          />
                        </td>
                        <td className="py-4 pr-4 text-center">
                          <Badge 
                            variant={device.assignedCount > 0 ? "default" : "secondary"}
                            className="min-w-[2rem]"
                          >
                            {device.assignedCount}
                          </Badge>
                        </td>
                        <td className="py-4">
                          {device.assignedRooms.length === 0 ? (
                            <span className="text-sm text-muted-foreground italic">No spaces assigned</span>
                          ) : device.assignedRooms.length <= 4 ? (
                            <div className="flex flex-wrap gap-1">
                              {device.assignedRooms.map((name: string, idx: number) => (
                                <Badge key={idx} variant="outline" className="text-xs">
                                  {name}
                                </Badge>
                              ))}
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {device.assignedRooms.slice(0, 3).map((name: string, idx: number) => (
                                <Badge key={idx} variant="outline" className="text-xs">
                                  {name}
                                </Badge>
                              ))}
                              <Badge variant="secondary" className="text-xs">
                                +{device.assignedRooms.length - 3} more
                              </Badge>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
