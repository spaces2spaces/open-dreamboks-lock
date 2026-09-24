import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { CommonArea, mockLogs, mockPins, mockQrCodes } from "@/lib/mockData";
import { lockDevicesAPI } from "@/lib/api";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import {
  Info,
  Key,
  Settings,
  FileText,
  MoreHorizontal,
  ShieldAlert,
  Lock,
  Footprints,
  Save,
  HelpCircle,
  ChevronDown,
  ArrowRightLeft
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

interface CommonAreaDetailProps {
  area: CommonArea;
  onUpdate: (area: CommonArea) => void;
}

type AccessScope = CommonArea["accessScope"];

export function CommonAreaDetail({ area, onUpdate }: CommonAreaDetailProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("info");
  const [floor, setFloor] = useState(area.floor || "");
  const [building, setBuilding] = useState(area.building || "");
  const [accessScope, setAccessScope] = useState<AccessScope>(area.accessScope || "universal");
  const [ordering, setOrdering] = useState("1"); // Mock default
  const [pmsId, setPmsId] = useState(area.id);
  const [ttlockId, setTtlockId] = useState<string>(area.ttlockId || "");
  const [isConversionDialogOpen, setIsConversionDialogOpen] = useState(false);
  const [selectedRoomLock, setSelectedRoomLock] = useState<string>("");

  const { data: lockDevices = [] } = useQuery({
    queryKey: ["lockDevices"],
    queryFn: lockDevicesAPI.getAll,
  });

  const convertToCommonMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => lockDevicesAPI.update(id, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["lockDevices"] });
      const device = lockDevices.find(d => d.id === variables.id);
      toast({
        title: "Device converted",
        description: `${device?.name} is now a common door lock.`,
      });
      setIsConversionDialogOpen(false);
      setSelectedRoomLock("");
    },
    onError: () => {
      toast({
        title: "Conversion failed",
        description: "Could not convert device to common door lock.",
        variant: "destructive",
      });
    },
  });

  const handleConvertToCommon = () => {
    if (!selectedRoomLock) return;
    const device = lockDevices.find(d => d.ttlockId === selectedRoomLock);
    if (!device) return;
    convertToCommonMutation.mutate({ id: device.id, data: { lockType: "common" } });
  };

  const areaPins = mockPins.filter(p => p.doors.includes(area.name) || p.doors.includes(area.id));
  // Mock some logs for the common area
  const areaLogs = mockLogs.filter(l => Math.random() > 0.5); 

  const handleSaveInfo = () => {
    onUpdate({
      ...area,
      floor: floor,
      building: building,
      accessScope: accessScope,
      ttlockId: ttlockId === "" ? null : ttlockId,
    });
    toast({
      title: "Common Area Updated",
      description: "Configuration has been saved successfully.",
    });
  };

  return (
    <div className="h-full flex flex-col bg-background rounded-xl border shadow-sm overflow-hidden">
      {/* Header Section */}
      <div className="px-8 pt-8 pb-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-3xl font-bold tracking-tight text-foreground">
            {area.name}
          </h2>
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="px-3 py-1.5 text-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 gap-2">
              <span className="w-2 h-2 rounded-full bg-primary"></span>
              Good
            </Badge>
            <Button variant="outline" size="icon" className="h-9 w-9">
              <MoreHorizontal className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Tabs Section */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <div className="px-8 border-b">
          <TabsList className="bg-transparent p-0 h-auto gap-8">
            {[
              { id: "info", label: "Info" },
              { id: "ekeys", label: "eKeys" },
              { id: "passcodes", label: "Passcodes" },
              { id: "cards", label: "Cards" },
              { id: "qr", label: "QR code" },
              { id: "records", label: "Records" }
            ].map(tab => (
              <TabsTrigger 
                key={tab.id} 
                value={tab.id}
                className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none px-0 pb-3 pt-0 text-muted-foreground data-[state=active]:text-foreground data-[state=active]:font-medium transition-all gap-2"
              >
                {tab.label}
              </TabsTrigger>
            ))}
            <Button variant="ghost" size="icon" className="h-8 w-8 ml-auto">
               <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
            </Button>
          </TabsList>
        </div>

        <div className="flex-1 overflow-y-auto p-8 bg-white">
          {/* INFO TAB */}
          <TabsContent value="info" className="mt-0 space-y-8 max-w-4xl">
             <div className="text-muted-foreground leading-relaxed">
                You can assign Common Area to each room in the Rooms section so that the travelers receive PINs and SmartKeys for each designated Common Area. Common Area PINs are the same for everyone.
             </div>

             <div className="space-y-6">
                <div className="grid grid-cols-2 gap-8">
                  <div className="space-y-2">
                    <Label htmlFor="floor" className="text-muted-foreground font-normal">Floor (Optional)</Label>
                    <Input 
                      id="floor" 
                      value={floor} 
                      onChange={(e) => setFloor(e.target.value)} 
                      className="max-w-full"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="building" className="text-muted-foreground font-normal">Building (Optional)</Label>
                    <Input 
                      id="building" 
                      value={building} 
                      onChange={(e) => setBuilding(e.target.value)} 
                      className="max-w-full"
                      placeholder="e.g., 213, 301, Main"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="access-scope" className="text-muted-foreground font-normal flex items-center gap-1">
                    Access Scope
                    <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/60" />
                  </Label>
                  <Select value={accessScope} onValueChange={(value) => setAccessScope(value as AccessScope)}>
                    <SelectTrigger id="access-scope" data-testid="select-access-scope">
                      <SelectValue placeholder="Select access scope" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="universal">Universal - All rooms get access</SelectItem>
                      <SelectItem value="building">Building - Only rooms in same building</SelectItem>
                      <SelectItem value="floor">Floor - Only rooms on same floor and building</SelectItem>
                      <SelectItem value="manual">Manual - Only manually assigned rooms</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {accessScope === "universal" && "All rooms will automatically receive passcodes for this common area."}
                    {accessScope === "building" && `Only rooms in building "${building || '(not set)'}" will receive passcodes.`}
                    {accessScope === "floor" && `Only rooms on floor "${floor || '(not set)'}" in building "${building || '(not set)'}" will receive passcodes.`}
                    {accessScope === "manual" && "Only rooms with this common area manually assigned will receive passcodes."}
                  </p>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="pms-id" className="text-muted-foreground font-normal">PMS ID (Optional)</Label>
                    <div className="relative">
                        <Input 
                            id="pms-id" 
                            value={pmsId} 
                            onChange={(e) => setPmsId(e.target.value)} 
                            className="pr-8 border-primary ring-1 ring-primary"
                        />
                         <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                            <ChevronDown className="w-4 h-4 text-muted-foreground" />
                         </div>
                    </div>
                </div>

                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="ttlock-device" className="text-muted-foreground font-normal">TTLock Device (Optional)</Label>
                      <Dialog open={isConversionDialogOpen} onOpenChange={setIsConversionDialogOpen}>
                        <DialogTrigger asChild>
                          <Button variant="link" size="sm" className="h-auto p-0 text-xs" data-testid="button-open-conversion-dialog">
                            <ArrowRightLeft className="w-3 h-3 mr-1" />
                            Convert room lock
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Convert Room Lock to Common Door</DialogTitle>
                            <DialogDescription>
                              Select a room lock to convert it into a common door lock. This will make it available for common area assignments.
                            </DialogDescription>
                          </DialogHeader>
                          <div className="space-y-4">
                            <RadioGroup value={selectedRoomLock} onValueChange={setSelectedRoomLock}>
                              <div className="space-y-2">
                                {lockDevices.filter(d => d.lockType === "room").length === 0 && (
                                  <p className="text-sm text-muted-foreground text-center py-4">
                                    No room locks available to convert.
                                  </p>
                                )}
                                {lockDevices
                                  .filter(device => device.lockType === "room")
                                  .map(device => (
                                    <div key={device.id} className="flex items-center space-x-3 border rounded-lg p-3 hover:bg-muted/50">
                                      <RadioGroupItem 
                                        value={device.ttlockId} 
                                        id={device.id}
                                        data-testid={`radio-convert-lock-${device.ttlockId}`}
                                      />
                                      <Label htmlFor={device.id} className="flex-1 cursor-pointer">
                                        <div className="font-medium">{device.name}</div>
                                        <div className="text-xs text-muted-foreground">{device.mac}</div>
                                      </Label>
                                    </div>
                                  ))}
                              </div>
                            </RadioGroup>
                            <div className="flex justify-end gap-2 pt-4">
                              <Button 
                                variant="outline" 
                                onClick={() => setIsConversionDialogOpen(false)}
                                data-testid="button-cancel-conversion"
                              >
                                Cancel
                              </Button>
                              <Button 
                                onClick={handleConvertToCommon}
                                disabled={!selectedRoomLock || convertToCommonMutation.isPending}
                                data-testid="button-confirm-conversion"
                              >
                                {convertToCommonMutation.isPending ? "Converting..." : "Convert to Common Door"}
                              </Button>
                            </div>
                          </div>
                        </DialogContent>
                      </Dialog>
                    </div>
                    <Select value={ttlockId || "none"} onValueChange={(value) => setTtlockId(value === "none" ? "" : value)}>
                      <SelectTrigger id="ttlock-device" data-testid="select-ttlock-device-common">
                        <SelectValue placeholder="Select TTLock device" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No lock</SelectItem>
                        {lockDevices
                          .filter(device => device.lockType === "common")
                          .map(device => (
                            <SelectItem key={device.id} value={device.ttlockId} data-testid={`option-ttlock-common-${device.ttlockId}`}>
                              {device.name} ({device.mac})
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                </div>
             </div>

             <div className="flex justify-end pt-4">
                <Button onClick={handleSaveInfo} className="gap-2" data-testid="button-save-common-area-info">
                  <Save className="w-4 h-4" />
                  Save Changes
                </Button>
             </div>

             <div className="pt-8 mt-8 border-t">
                <p className="text-muted-foreground text-sm max-w-xl leading-relaxed">
                  Goki will detect room locks and your room/bed configuration automatically and generates PIN/Key at check-in time.
                </p>
             </div>
          </TabsContent>

          {/* EKEYS TAB (New) */}
          <TabsContent value="ekeys" className="mt-0 space-y-6 max-w-4xl">
            <Card>
               <CardHeader className="flex flex-row items-center justify-between">
                 <div>
                    <CardTitle>eKeys</CardTitle>
                    <CardDescription>Manage digital keys sent to users</CardDescription>
                 </div>
                 <div className="flex gap-2">
                    <Input placeholder="Enter name or account" className="w-[200px]" />
                    <Button variant="outline">Send eKey</Button>
                 </div>
               </CardHeader>
               <CardContent>
                  <div className="border rounded-md">
                      <div className="grid grid-cols-6 p-4 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                          <div className="col-span-1">Name</div>
                          <div className="col-span-1">Recipient Account</div>
                          <div className="col-span-1">Assigner</div>
                          <div className="col-span-1">Assigning Time</div>
                          <div className="col-span-1">Validity Period</div>
                          <div className="col-span-1 text-right">Unlock link</div>
                      </div>
                      <div className="p-8 text-center text-muted-foreground text-sm">
                          No eKeys found
                      </div>
                  </div>
               </CardContent>
            </Card>
          </TabsContent>

          {/* PASSCODES TAB (Renamed from PINs) */}
          <TabsContent value="passcodes" className="mt-0 space-y-6 max-w-4xl">
             {/* Reuse PINs layout */}
             <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-lg">Active Passcodes</h3>
                </div>
                <div className="grid gap-3">
                    {areaPins.length > 0 ? areaPins.map(pin => (
                        <div key={pin.id} className="flex items-center justify-between p-4 bg-card border rounded-xl shadow-sm">
                            <div className="flex items-start gap-4">
                                <div className={cn(
                                    "w-10 h-10 rounded-full flex items-center justify-center",
                                    "bg-gray-100 text-gray-600"
                                )}>
                                    <Key className="w-5 h-5" />
                                </div>
                                <div>
                                    <div className="flex items-center gap-2">
                                        <span className="font-bold">{pin.name}</span>
                                        <Badge variant="outline">{pin.type}</Badge>
                                    </div>
                                    <div className="text-sm text-muted-foreground mt-0.5">
                                        {format(new Date(pin.validFrom), "MMM d")} - {format(new Date(pin.validTo), "MMM d")}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )) : (
                        <div className="text-center py-8 text-muted-foreground border-2 border-dashed rounded-xl">
                            No specific manual PINs created for this common area yet.
                        </div>
                    )}
                </div>
             </div>
          </TabsContent>

          {/* CARDS TAB (New) */}
          <TabsContent value="cards" className="mt-0 space-y-6 max-w-4xl">
             <Card>
               <CardHeader className="flex flex-row items-center justify-between">
                 <div>
                    <CardTitle>IC Cards</CardTitle>
                    <CardDescription>Manage physical access cards</CardDescription>
                 </div>
                 <Button variant="outline">Add Card</Button>
               </CardHeader>
               <CardContent>
                  <div className="border rounded-md">
                      <div className="grid grid-cols-4 p-4 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                          <div className="col-span-1">Card Number</div>
                          <div className="col-span-1">Name</div>
                          <div className="col-span-1">Validity</div>
                          <div className="col-span-1 text-right">Action</div>
                      </div>
                      <div className="p-8 text-center text-muted-foreground text-sm">
                          No cards registered
                      </div>
                  </div>
               </CardContent>
            </Card>
          </TabsContent>

          {/* QR CODE TAB (New) */}
          <TabsContent value="qr" className="mt-0 space-y-6 max-w-4xl">
             <Card>
               <CardHeader className="flex flex-row items-center justify-between pb-2">
                 <div className="flex items-center gap-2 w-full">
                    <div className="relative flex-1 max-w-md">
                        <Input placeholder="Please enter the name" className="pr-8" />
                        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none">
                             {/* Search icon would go here if imported, using text for now or assuming import */}
                             <span className="text-muted-foreground">🔍</span>
                        </div>
                    </div>
                 </div>
                 <div className="flex gap-2 shrink-0">
                    <Button variant="outline" className="text-primary hover:text-primary border-primary/20 hover:bg-primary/5">Add QR code</Button>
                    <Button variant="outline" className="text-destructive hover:text-destructive border-destructive/20 hover:bg-destructive/5">Clear</Button>
                 </div>
               </CardHeader>
               <CardContent>
                  <div className="border rounded-md overflow-hidden">
                      <div className="grid grid-cols-12 p-4 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                          <div className="col-span-2">Name</div>
                          <div className="col-span-2">Assigner</div>
                          <div className="col-span-3">Assigning Time</div>
                          <div className="col-span-2">Validity Period</div>
                          <div className="col-span-1">Status</div>
                          <div className="col-span-2">Operation</div>
                      </div>
                      
                      {mockQrCodes.length > 0 ? (
                        <div className="divide-y">
                            {mockQrCodes.map(qr => (
                                <div key={qr.id} className="grid grid-cols-12 p-4 text-sm items-center hover:bg-muted/20 transition-colors">
                                    <div className="col-span-2 font-medium">{qr.name}</div>
                                    <div className="col-span-2 text-muted-foreground">{qr.assigner}</div>
                                    <div className="col-span-3 text-muted-foreground">{qr.assigningTime}</div>
                                    <div className="col-span-2 text-muted-foreground">{qr.validityPeriod}</div>
                                    <div className="col-span-1 text-muted-foreground">{qr.status}</div>
                                    <div className="col-span-2 flex flex-col gap-1 text-xs">
                                        <div className="flex gap-3">
                                            <button className="text-primary hover:underline">Copy link</button>
                                            <button className="text-primary hover:underline">Edit</button>
                                            <button className="text-primary hover:underline">More</button>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                      ) : (
                        <div className="p-8 text-center text-muted-foreground text-sm">
                            No QR codes active
                        </div>
                      )}
                  </div>
               </CardContent>
            </Card>
          </TabsContent>

          {/* RECORDS TAB (Renamed from Logs) */}
          <TabsContent value="records" className="mt-0 space-y-6 max-w-4xl">
             <Card>
               <CardHeader>
                 <CardTitle>Records</CardTitle>
                 <CardDescription>Unlock records and activity logs</CardDescription>
               </CardHeader>
               <CardContent>
                 <ScrollArea className="h-[400px] pr-4">
                   <div className="space-y-4">
                     {areaLogs.map(log => (
                       <div key={log.id} className="flex gap-3 text-sm">
                         <div className="font-mono text-xs text-muted-foreground w-32 shrink-0">
                           {format(new Date(log.timestamp), "MMM d, HH:mm:ss")}
                         </div>
                         <div className="flex-1">
                           <p>{log.message}</p>
                           <p className="text-xs text-muted-foreground mt-0.5">Source: {log.source}</p>
                         </div>
                       </div>
                     ))}
                   </div>
                 </ScrollArea>
               </CardContent>
             </Card>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
