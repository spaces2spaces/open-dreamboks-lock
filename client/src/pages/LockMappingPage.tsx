import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { roomsAPI, lockDevicesAPI, roomLockAssignmentsAPI, settingsAPI } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Search, Lock, Building2, RefreshCw, Save, ChevronRight, ChevronLeft, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export default function LockMappingPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [selectedLockId, setSelectedLockId] = useState<string>("");
  const [lockSearch, setLockSearch] = useState("");
  const [leftSearch, setLeftSearch] = useState("");
  const [rightSearch, setRightSearch] = useState("");
  const [leftSelected, setLeftSelected] = useState<Set<string>>(new Set());
  const [rightSelected, setRightSelected] = useState<Set<string>>(new Set());
  const [assignedRoomIds, setAssignedRoomIds] = useState<Set<string>>(new Set());
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const { data: rooms = [], isLoading: roomsLoading } = useQuery({
    queryKey: ["rooms"],
    queryFn: roomsAPI.getAll,
  });

  const { data: lockDevices = [], isLoading: devicesLoading } = useQuery({
    queryKey: ["lockDevices"],
    queryFn: lockDevicesAPI.getAll,
  });

  const { data: assignments = [], isLoading: assignmentsLoading } = useQuery({
    queryKey: ["roomLockAssignments"],
    queryFn: roomLockAssignmentsAPI.getAll,
  });

  const { data: settings = [] } = useQuery({
    queryKey: ["settings"],
    queryFn: settingsAPI.getAll,
  });

  // Capsule/dormitory hotels: one physical room lock may be shared by several
  // spaces (e.g. "101" and "101s"). When enabled, the one-space-per-room-lock
  // guard is lifted both in the picker and when assigning.
  const allowSharedRoomLocks = useMemo(
    () => settings.some((s: any) => s.key === "allow_shared_room_locks" && s.value === "true"),
    [settings]
  );

  const syncDevicesMutation = useMutation({
    mutationFn: lockDevicesAPI.sync,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["lockDevices"] });
      queryClient.invalidateQueries({ queryKey: ["lock-devices"] });
      toast({ title: `Synced: ${data.totalLocks} locks (${data.imported} new, ${data.updated} updated)` });
    },
    onError: () => {
      toast({ title: "Failed to sync lock devices", variant: "destructive" });
    },
  });

  const createBulkMutation = useMutation({
    mutationFn: roomLockAssignmentsAPI.createBulk,
  });

  const deleteBulkMutation = useMutation({
    mutationFn: roomLockAssignmentsAPI.deleteBulk,
  });

  const currentAssignmentsForLock = useMemo(() => {
    if (!selectedLockId) return [];
    return assignments.filter((a: any) => a.lockDeviceId === selectedLockId);
  }, [assignments, selectedLockId]);

  const originalRoomIds = useMemo(() => {
    return new Set(currentAssignmentsForLock.map((a: any) => a.roomId));
  }, [currentAssignmentsForLock]);

  const selectedLock = lockDevices.find((d: any) => d.id === selectedLockId);
  const isRoomLock = selectedLock?.lockType !== "common";

  const sortedLockDevices = useMemo(() => {
    const lockAssignmentCounts = new Map<string, number>();
    for (const a of assignments) {
      lockAssignmentCounts.set(a.lockDeviceId, (lockAssignmentCounts.get(a.lockDeviceId) || 0) + 1);
    }

    return [...lockDevices]
      .sort((a: any, b: any) => {
        const aCount = lockAssignmentCounts.get(a.id) || 0;
        const bCount = lockAssignmentCounts.get(b.id) || 0;
        // Unmapped (0 assignments) first
        if ((aCount === 0) !== (bCount === 0)) return aCount === 0 ? -1 : 1;
        // Common doors before room doors
        if (a.lockType !== b.lockType) return a.lockType === "common" ? -1 : 1;
        // Numeric sort by name
        return a.name.localeCompare(b.name, undefined, { numeric: true });
      });
  }, [lockDevices, assignments]);

  const filteredLockDevices = useMemo(() => {
    if (!lockSearch) return sortedLockDevices;
    const q = lockSearch.toLowerCase();
    return sortedLockDevices.filter((d: any) => d.name.toLowerCase().includes(q));
  }, [sortedLockDevices, lockSearch]);

  const roomsWithRoomLockAssigned = useMemo(() => {
    const roomLockDeviceIds = lockDevices
      .filter((d: any) => d.lockType !== "common")
      .map((d: any) => d.id);
    
    return new Set(
      assignments
        .filter((a: any) => roomLockDeviceIds.includes(a.lockDeviceId))
        .map((a: any) => a.roomId)
    );
  }, [assignments, lockDevices]);

  const roomLocksAlreadyMapped = useMemo(() => {
    return new Set(
      lockDevices
        .filter((d: any) => d.lockType !== "common")
        .filter((d: any) => assignments.some((a: any) => a.lockDeviceId === d.id))
        .map((d: any) => d.id)
    );
  }, [assignments, lockDevices]);

  const handleSelectLock = (lockId: string) => {
    if (hasChanges) {
      if (!confirm("You have unsaved changes. Switch lock without saving?")) {
        return;
      }
    }
    setSelectedLockId(lockId);
    const currentRooms = assignments
      .filter((a: any) => a.lockDeviceId === lockId)
      .map((a: any) => a.roomId);
    setAssignedRoomIds(new Set(currentRooms));
    setLeftSelected(new Set());
    setRightSelected(new Set());
    setHasChanges(false);
  };

  const availableRooms = useMemo(() => {
    return rooms.filter(room => {
      if (assignedRoomIds.has(room.id)) return false;
      // Normally a space with a room lock elsewhere is hidden, but shared-lock
      // tenants must be able to add a 2nd space to the same lock.
      if (isRoomLock && !allowSharedRoomLocks && roomsWithRoomLockAssigned.has(room.id)) return false;
      return true;
    });
  }, [rooms, assignedRoomIds, isRoomLock, roomsWithRoomLockAssigned, allowSharedRoomLocks]);

  const selectedRooms = useMemo(() => {
    return rooms.filter(room => assignedRoomIds.has(room.id));
  }, [rooms, assignedRoomIds]);

  const filteredAvailable = useMemo(() => {
    if (!leftSearch) return availableRooms;
    return availableRooms.filter(room =>
      room.name.toLowerCase().includes(leftSearch.toLowerCase())
    );
  }, [availableRooms, leftSearch]);

  const filteredSelected = useMemo(() => {
    if (!rightSearch) return selectedRooms;
    return selectedRooms.filter(room =>
      room.name.toLowerCase().includes(rightSearch.toLowerCase())
    );
  }, [selectedRooms, rightSearch]);

  const selectAllLeft = () => {
    setLeftSelected(prev => {
      const newSet = new Set(prev);
      filteredAvailable.forEach(r => newSet.add(r.id));
      return newSet;
    });
  };

  const selectNoneLeft = () => {
    setLeftSelected(prev => {
      const newSet = new Set(prev);
      filteredAvailable.forEach(r => newSet.delete(r.id));
      return newSet;
    });
  };

  const selectAllRight = () => {
    setRightSelected(prev => {
      const newSet = new Set(prev);
      filteredSelected.forEach(r => newSet.add(r.id));
      return newSet;
    });
  };

  const selectNoneRight = () => {
    setRightSelected(prev => {
      const newSet = new Set(prev);
      filteredSelected.forEach(r => newSet.delete(r.id));
      return newSet;
    });
  };

  const isAllLeftSelected = filteredAvailable.length > 0 && filteredAvailable.every(r => leftSelected.has(r.id));
  const isAllRightSelected = filteredSelected.length > 0 && filteredSelected.every(r => rightSelected.has(r.id));

  const moveToRight = () => {
    if (leftSelected.size === 0) return;

    if (isRoomLock && !allowSharedRoomLocks) {
      // Exclusive room lock: only one space may hold it.
      const firstSelected = Array.from(leftSelected)[0];
      setAssignedRoomIds(new Set([firstSelected]));
      setLeftSelected(new Set());
      setHasChanges(true);
    } else {
      // Common doors and shared room locks: assign all selected spaces.
      setAssignedRoomIds(prev => {
        const newSet = new Set(prev);
        leftSelected.forEach(id => newSet.add(id));
        return newSet;
      });
      setLeftSelected(new Set());
      setHasChanges(true);
    }
  };

  const moveToLeft = () => {
    if (rightSelected.size === 0) return;
    setAssignedRoomIds(prev => {
      const newSet = new Set(prev);
      rightSelected.forEach(id => newSet.delete(id));
      return newSet;
    });
    setRightSelected(new Set());
    setHasChanges(true);
  };

  const toggleLeftSelect = (roomId: string, checked: boolean) => {
    setLeftSelected(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(roomId);
      } else {
        newSet.delete(roomId);
      }
      return newSet;
    });
  };

  const toggleRightSelect = (roomId: string, checked: boolean) => {
    setRightSelected(prev => {
      const newSet = new Set(prev);
      if (checked) {
        newSet.add(roomId);
      } else {
        newSet.delete(roomId);
      }
      return newSet;
    });
  };

  const handleSaveChanges = async () => {
    if (!selectedLockId) return;
    setIsSaving(true);

    const toAdd = Array.from(assignedRoomIds).filter(roomId => !originalRoomIds.has(roomId));
    const toRemove = currentAssignmentsForLock.filter((a: any) => !assignedRoomIds.has(a.roomId));

    try {
      if (toAdd.length > 0) {
        await createBulkMutation.mutateAsync(
          toAdd.map(roomId => ({
            roomId,
            lockDeviceId: selectedLockId,
            assignmentType: "room_lock",
          }))
        );
      }

      if (toRemove.length > 0) {
        await deleteBulkMutation.mutateAsync(toRemove.map((a: any) => a.id));
      }

      await queryClient.invalidateQueries({ queryKey: ["roomLockAssignments"] });
      await queryClient.invalidateQueries({ queryKey: ["lockDevices"] });
      await queryClient.invalidateQueries({ queryKey: ["lock-devices"] });
      toast({ title: `Saved: ${toAdd.length} added, ${toRemove.length} removed` });
      setHasChanges(false);
    } catch (error) {
      // Surface the server's explanation — e.g. the >20 bulk-delete safety
      // guard returns a 409 telling the admin to repeat with force. A bare
      // "Error saving changes" hid that and looked like a technical fault.
      toast({
        title: "Error saving changes",
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (roomsLoading || devicesLoading || assignmentsLoading) {
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
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Lock Mapping</h1>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => syncDevicesMutation.mutate()}
            disabled={syncDevicesMutation.isPending}
            data-testid="button-sync-devices"
          >
            <RefreshCw className={cn("w-4 h-4", syncDevicesMutation.isPending && "animate-spin")} />
            Sync TTLock
          </Button>
        </div>
      </div>

      <Card className="mb-6">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Lock className="w-4 h-4" />
              Locks ({lockDevices.length})
            </CardTitle>
            {hasChanges && (
              <Button
                onClick={handleSaveChanges}
                disabled={isSaving}
                size="sm"
                data-testid="button-save-changes"
              >
                <Save className="w-4 h-4 mr-2" />
                {isSaving ? "Saving..." : "Save changes"}
              </Button>
            )}
          </div>
          <div className="relative mt-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search locks..."
              className="pl-9 h-9"
              value={lockSearch}
              onChange={(e) => setLockSearch(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="border rounded-lg max-h-[240px] overflow-y-auto bg-white">
            {filteredLockDevices.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                No locks found
              </div>
            ) : (
              <div className="divide-y">
                {filteredLockDevices.map((device: any) => {
                  const count = assignments.filter((a: any) => a.lockDeviceId === device.id).length;
                  const isSelected = device.id === selectedLockId;
                  const isUnmapped = count === 0;
                  return (
                    <button
                      key={device.id}
                      onClick={() => handleSelectLock(device.id)}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 w-full text-left transition-colors",
                        isSelected
                          ? "bg-primary/10 border-l-2 border-l-primary"
                          : "hover:bg-gray-50 border-l-2 border-l-transparent",
                        isUnmapped && !isSelected && "bg-amber-50/50"
                      )}
                      data-testid={`lock-${device.id}`}
                    >
                      {isUnmapped && (
                        <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm truncate">{device.name}</div>
                        <div className="text-xs text-muted-foreground">{device.mac}</div>
                      </div>
                      <Badge variant={device.lockType === "common" ? "secondary" : "outline"} className="text-xs flex-shrink-0">
                        {device.lockType === "common" ? "Common" : "Room"}
                      </Badge>
                      <Badge variant={isUnmapped ? "destructive" : "default"} className="text-xs flex-shrink-0">
                        {count}
                      </Badge>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {selectedLockId ? (
        <div className="grid grid-cols-2 gap-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Building2 className="w-4 h-4" />
                  Alle Spaces
                </span>
                <Badge variant="secondary">{availableRooms.length}</Badge>
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Select spaces and click the arrow to assign to the lock
              </p>
              <div className="relative mt-2">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search spaces..."
                  className="pl-9 h-9"
                  value={leftSearch}
                  onChange={(e) => setLeftSearch(e.target.value)}
                  data-testid="input-search-available"
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className="border rounded-lg h-[400px] overflow-y-auto bg-white">
                {filteredAvailable.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                    {leftSearch ? "No results" : "All spaces are assigned"}
                  </div>
                ) : (
                  <div className="divide-y">
                    <label
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors bg-gray-50 border-b-2 sticky top-0",
                        isAllLeftSelected ? "bg-blue-100" : "hover:bg-gray-100"
                      )}
                      data-testid="select-all-available"
                    >
                      <Checkbox
                        checked={isAllLeftSelected}
                        onCheckedChange={(checked) => checked ? selectAllLeft() : selectNoneLeft()}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">Select all ({filteredAvailable.length})</div>
                      </div>
                    </label>
                    {filteredAvailable.map(room => (
                      <label
                        key={room.id}
                        className={cn(
                          "flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors",
                          leftSelected.has(room.id)
                            ? "bg-blue-50"
                            : "hover:bg-gray-50"
                        )}
                        data-testid={`available-room-${room.id}`}
                      >
                        <Checkbox
                          checked={leftSelected.has(room.id)}
                          onCheckedChange={(checked) => toggleLeftSelect(room.id, !!checked)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">{room.name}</div>
                          {room.spaceCategory && (
                            <div className="text-xs text-muted-foreground">{room.spaceCategory}</div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              
              <div className="flex items-center justify-between mt-3">
                <span className="text-sm text-muted-foreground">
                  {leftSelected.size > 0 ? `${leftSelected.size} selected` : "None selected"}
                </span>
                <Button
                  onClick={moveToRight}
                  disabled={leftSelected.size === 0}
                  size="sm"
                  data-testid="button-move-right"
                >
                  Assign to lock
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="border-primary/30">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <Lock className="w-4 h-4 text-primary" />
                  Assigned to: {selectedLock?.name}
                </span>
                <Badge variant="default">{selectedRooms.length}</Badge>
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Spaces that have access via this lock
              </p>
              <div className="relative mt-2">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search assigned..."
                  className="pl-9 h-9"
                  value={rightSearch}
                  onChange={(e) => setRightSearch(e.target.value)}
                  data-testid="input-search-assigned"
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className="border rounded-lg h-[400px] overflow-y-auto bg-white">
                {filteredSelected.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                    {rightSearch ? "No results" : "No spaces assigned yet"}
                  </div>
                ) : (
                  <div className="divide-y">
                    <label
                      className={cn(
                        "flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors bg-gray-50 border-b-2 sticky top-0",
                        isAllRightSelected ? "bg-blue-100" : "hover:bg-gray-100"
                      )}
                      data-testid="select-all-assigned"
                    >
                      <Checkbox
                        checked={isAllRightSelected}
                        onCheckedChange={(checked) => checked ? selectAllRight() : selectNoneRight()}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">Select all ({filteredSelected.length})</div>
                      </div>
                    </label>
                    {filteredSelected.map(room => (
                      <label
                        key={room.id}
                        className={cn(
                          "flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors",
                          rightSelected.has(room.id)
                            ? "bg-blue-50"
                            : "hover:bg-gray-50"
                        )}
                        data-testid={`assigned-room-${room.id}`}
                      >
                        <Checkbox
                          checked={rightSelected.has(room.id)}
                          onCheckedChange={(checked) => toggleRightSelect(room.id, !!checked)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">{room.name}</div>
                          {room.spaceCategory && (
                            <div className="text-xs text-muted-foreground">{room.spaceCategory}</div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              
              <div className="flex items-center justify-between mt-3">
                <Button
                  onClick={moveToLeft}
                  disabled={rightSelected.size === 0}
                  size="sm"
                  variant="outline"
                  data-testid="button-move-left"
                >
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Remove from lock
                </Button>
                <span className="text-sm text-muted-foreground">
                  {rightSelected.size > 0 ? `${rightSelected.size} selected` : "None selected"}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <Card>
          <CardContent className="py-16 text-center">
            <Lock className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
            <p className="text-muted-foreground">Select a lock above to assign spaces</p>
          </CardContent>
        </Card>
      )}
    </DashboardLayout>
  );
}
